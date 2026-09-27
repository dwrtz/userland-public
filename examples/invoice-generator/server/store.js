// Data access, validation, and money math for clients, quotes, and invoices.
//
// Every row carries a `workspace` field. A normal app keeps all of its rows in
// the "main" workspace; the public demo gives each visitor a separate workspace
// (see demo.js) so visitors never see each other's data.
//
// Money is always whole cents (integers). Totals are computed on the server and
// stored with the document, so a printed invoice never depends on browser math.
//
// Rules that must hold even when two requests arrive at the same moment are
// enforced by unique indexes in manifest.userland.json, not by reading first:
//   clients.by_email    one client per email address in a workspace
//   documents.by_number one document per number (per workspace and kind); it
//                       also makes a quote convert into only one invoice (see
//                       convertQuote)
// A clashing write throws a `unique_conflict` error, which the code below catches.

import { STUDIO } from "./studio.js";

export const MAIN_WORKSPACE = "main";

export const LIMITS = {
  name: 120,
  company: 120,
  email: 200,
  address: 400,
  clientNotes: 1000,
  title: 140,
  notes: 1500,
  message: 2000,
  lineDescription: 200,
  lines: 20,
  maxQuantity: 100000,
  maxUnitCents: 100000000, // $1,000,000.00
  maxTaxPercent: 50,
  // Public form caps, so a bot can't fill the app's storage with requests.
  // New requests are refused (with a friendly message) while this many are
  // waiting for a reply, or while one email address has this many waiting.
  pendingRequests: 50,
  requestsPerClient: 3,
  // Rows per page on the desk, the client list, and a client's documents.
  pageSize: 50
};

// Allowed status changes. The owner moves documents along these edges; the
// client can only accept or decline a sent quote (see respondToQuote).
const TRANSITIONS = {
  quote: {
    requested: ["draft", "declined"],
    draft: ["sent"],
    sent: ["accepted", "declined", "draft"],
    accepted: ["sent"],
    declined: ["draft"],
    converted: []
  },
  invoice: {
    draft: ["sent", "void"],
    sent: ["paid", "draft", "void"],
    paid: ["sent"],
    void: ["draft"]
  }
};

// Statuses a client may see through their private link.
const CLIENT_VISIBLE = new Set(["sent", "accepted", "declined", "converted", "paid"]);

// An invoice made from a quote holds this placeholder number for a moment,
// until it gets its real number (see convertQuote).
const PENDING_NUMBER = "pending-";

// ---------------------------------------------------------------------------
// Errors from ctx.data

/** True for a write that clashed with a unique index. */
export function isUniqueConflict(error) {
  // Userland reports `unique_conflict`; the local test runtime calls it `unique_violation`.
  return error?.code === "unique_conflict" || error?.code === "unique_violation";
}

/** True when the app has reached a plan limit, such as its row count. */
export function isQuotaExceeded(error) {
  return error?.code === "quota_exceeded";
}

/** True when so many saves arrived at once that this one gave up (see withNextNumber). Callers ask the visitor to try again. */
export function isBusy(error) {
  return error?.code === "busy";
}

// ---------------------------------------------------------------------------
// Input helpers

/** Trim, normalize line breaks, and drop control characters. */
export function cleanText(value, { multiline = false } = {}) {
  if (typeof value !== "string") return "";
  let text = value.replace(/\r\n?/g, "\n");
  text = multiline ? text.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "") : text.replace(/[\u0000-\u001F\u007F]+/g, " ");
  text = multiline ? text.replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  return text.trim();
}

export function isEmail(value) {
  return value.length <= LIMITS.email && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value);
}

export function isId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function isToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(value);
}

/** Parses "1,250.50", "$1250.5", or "€40" into cents. Returns null when invalid. */
export function parseMoney(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^\p{Sc}\s*/u, "")
    .replace(/,/g, "");
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Parses a quantity such as "3" or "2.5" (hours, days, items). */
export function parseQuantity(value) {
  const text = String(value ?? "").trim().replace(/,/g, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return null;
  const quantity = Number(text);
  return quantity > 0 && quantity <= LIMITS.maxQuantity ? quantity : null;
}

export function parsePercent(value) {
  const text = String(value ?? "").trim().replace(/%$/, "");
  if (text === "") return 0;
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(text)) return null;
  const percent = Number(text);
  return percent <= LIMITS.maxTaxPercent ? percent : null;
}

export function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Calendar dates are stored as "YYYY-MM-DD" strings. "Today" is the date in the
// studio's time zone, not UTC, so evening work in the US isn't dated tomorrow.
const calendarDate = new Intl.DateTimeFormat("en-US", { timeZone: STUDIO.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

export function today(now = new Date()) {
  const parts = Object.fromEntries(calendarDate.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** A random, URL-safe string. Used for private client links. */
export function randomToken(bytes = 18) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...values)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Money math, in whole numbers only. Quantities have at most two decimals and
// tax rates at most three, so both are scaled to integers before multiplying;
// halves round up (0.57 × $1.50 = $0.855 → $0.86). public/assets/app.js
// repeats these two functions for the live preview.

/** Cents for one line: quantity × unit price, rounded to the nearest cent. */
export function lineCents(quantity, unitCents) {
  const hundredths = Math.round(quantity * 100);
  return Math.floor((hundredths * unitCents + 50) / 100);
}

/** Tax in cents for a subtotal at a percent such as 8.25, rounded to the nearest cent. */
export function taxCents(subtotalCents, percent) {
  const thousandths = BigInt(Math.round(percent * 1000));
  return Number((BigInt(subtotalCents) * thousandths + 50000n) / 100000n);
}

export function computeTotals(lineItems, taxPercent) {
  const items = lineItems.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unit_cents: item.unit_cents,
    amount_cents: lineCents(item.quantity, item.unit_cents)
  }));
  const subtotal = items.reduce((sum, item) => sum + item.amount_cents, 0);
  const tax = taxCents(subtotal, taxPercent);
  return { line_items: items, subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax };
}

// ---------------------------------------------------------------------------
// Form parsing. Each parser returns { values, errors }; errors maps a field
// name to a message the page shows next to that field.

export function parseClientForm(form) {
  const values = {
    name: cleanText(form.get("name")),
    company: cleanText(form.get("company")),
    email: cleanText(form.get("email")).toLowerCase(),
    address: cleanText(form.get("address"), { multiline: true }),
    notes: cleanText(form.get("notes"), { multiline: true })
  };
  const errors = {};
  if (!values.name) errors.name = "Enter the client's name.";
  else if (values.name.length > LIMITS.name) errors.name = `Keep the name under ${LIMITS.name} characters.`;
  if (values.company.length > LIMITS.company) errors.company = `Keep the company under ${LIMITS.company} characters.`;
  if (!values.email) errors.email = "Enter an email address.";
  else if (!isEmail(values.email)) errors.email = "Enter an email address like name@example.com.";
  if (values.address.length > LIMITS.address) errors.address = `Keep the address under ${LIMITS.address} characters.`;
  if (values.notes.length > LIMITS.clientNotes) errors.notes = `Keep notes under ${LIMITS.clientNotes} characters.`;
  return { values, errors };
}

export function parseRequestForm(form) {
  const { values: client, errors } = parseClientForm(form);
  delete errors.address;
  delete errors.notes;
  const serviceId = cleanText(form.get("service"));
  const service = STUDIO.services.find((item) => item.id === serviceId) ?? null;
  const message = cleanText(form.get("message"), { multiline: true });
  if (!service) errors.service = "Choose the kind of work you need.";
  if (!message) errors.message = "Tell us a little about the project.";
  else if (message.length > LIMITS.message) errors.message = `Keep this under ${LIMITS.message} characters.`;
  return {
    values: { name: client.name, company: client.company, email: client.email, service: serviceId, message },
    service,
    errors
  };
}

export function parseDocumentForm(form) {
  const values = {
    client_id: cleanText(form.get("client_id")),
    title: cleanText(form.get("title")),
    issue_date: cleanText(form.get("issue_date")),
    due_date: cleanText(form.get("due_date")),
    tax_percent: cleanText(form.get("tax_percent")),
    notes: cleanText(form.get("notes"), { multiline: true })
  };
  const errors = {};
  if (!isId(values.client_id)) errors.client_id = "Choose a client.";
  if (!values.title) errors.title = "Give the project a short title.";
  else if (values.title.length > LIMITS.title) errors.title = `Keep the title under ${LIMITS.title} characters.`;
  if (values.issue_date && !isDate(values.issue_date)) errors.issue_date = "Use a date like 2026-09-30.";
  if (values.due_date && !isDate(values.due_date)) errors.due_date = "Use a date like 2026-10-14.";
  // A blank first date is saved as today, so the due date is checked against today then.
  else if (values.due_date && !errors.issue_date && values.due_date < (values.issue_date || today())) errors.due_date = "Pick a date on or after the first date.";
  if (values.notes.length > LIMITS.notes) errors.notes = `Keep notes under ${LIMITS.notes} characters.`;

  const taxPercent = parsePercent(values.tax_percent);
  if (taxPercent === null) errors.tax_percent = `Use a number from 0 to ${LIMITS.maxTaxPercent}.`;

  // Line items arrive as parallel lists: item_description[], item_quantity[], item_rate[].
  const descriptions = form.getAll("item_description");
  const quantities = form.getAll("item_quantity");
  const rates = form.getAll("item_rate");
  const rows = [];
  const lines = [];
  for (let index = 0; index < Math.min(descriptions.length, 60); index += 1) {
    const raw = {
      description: cleanText(descriptions[index]),
      quantity: cleanText(quantities[index] ?? ""),
      rate: cleanText(rates[index] ?? "")
    };
    if (!raw.description && !raw.rate && (!raw.quantity || raw.quantity === "1")) continue; // empty row
    rows.push(raw);
    const quantity = parseQuantity(raw.quantity || "1");
    const unitCents = parseMoney(raw.rate);
    if (!raw.description || raw.description.length > LIMITS.lineDescription || quantity === null || unitCents === null || unitCents > LIMITS.maxUnitCents) {
      errors.line_items = `Check line ${rows.length}: it needs a description (under ${LIMITS.lineDescription} characters), a quantity above 0, and a price like 1,250.00.`;
      continue;
    }
    lines.push({ description: raw.description, quantity, unit_cents: unitCents });
  }
  if (!errors.line_items && lines.length === 0) errors.line_items = "Add at least one line with a description and price.";
  if (rows.length > LIMITS.lines) errors.line_items = `Use ${LIMITS.lines} lines or fewer.`;

  return { values: { ...values, rows }, lines, taxPercent: taxPercent ?? 0, errors };
}

// ---------------------------------------------------------------------------
// Queries. `list` returns at most 100 rows and a `cursor` when there are more.

/** Every row matching the query, reading page after page until the last one. */
async function listEvery(collection, query) {
  const rows = [];
  let cursor;
  do {
    const page = await collection.list({ ...query, limit: 100, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

/** Rows from the start of a sorted query for as long as `keep(row)` is true. */
async function listWhile(collection, query, keep) {
  const rows = [];
  let cursor;
  do {
    const page = await collection.list({ ...query, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) {
      if (!keep(row)) return rows;
      rows.push(row);
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

/**
 * One page of a query. `cursor` comes from the previous page's `next`. With
 * `keep`, rows it rejects are skipped and more are read to fill the page; each
 * read asks for exactly the rows still needed, so `next` starts right after the
 * last row read and no row is skipped or shown twice.
 */
async function listPage(collection, query, cursor, keep = null) {
  const rows = [];
  let next = isCursor(cursor) ? cursor : null;
  do {
    const page = await collection.list({ ...query, limit: LIMITS.pageSize - rows.length, ...(next ? { cursor: next } : {}) });
    rows.push(...(keep ? page.rows.filter(keep) : page.rows));
    next = page.cursor ?? null;
  } while (next && rows.length < LIMITS.pageSize);
  return { rows, next };
}

export function isCursor(value) {
  return typeof value === "string" && /^[A-Za-z0-9+/=_-]{1,200}$/.test(value);
}

// ---------------------------------------------------------------------------
// Clients

const BY_NAME = [{ field: "name", direction: "asc" }];

/** Every client, sorted by name. Used for the client picker and name lookups. */
export async function listClients(db, workspace) {
  return await listEvery(db.collection("clients"), { where: { workspace }, order_by: BY_NAME });
}

/** One page of the client list, sorted by name. */
export async function listClientsPage(db, workspace, cursor) {
  return await listPage(db.collection("clients"), { where: { workspace }, order_by: BY_NAME }, cursor);
}

export async function getClient(db, workspace, id) {
  if (!isId(id)) return null;
  const row = await db.collection("clients").get(id);
  return row && row.workspace === workspace ? row : null;
}

export async function findClientByEmail(db, workspace, email) {
  const result = await db.collection("clients").list({ where: { workspace, email }, limit: 1 });
  return result.rows[0] ?? null;
}

/** Adds a client. Returns null when another client already has this email. */
export async function createClient(db, workspace, values) {
  try {
    return await db.collection("clients").create({
      workspace,
      name: values.name,
      company: values.company ?? "",
      email: values.email,
      address: values.address ?? "",
      notes: values.notes ?? ""
    });
  } catch (error) {
    if (isUniqueConflict(error)) return null;
    throw error;
  }
}

/** The client with this email, adding them first if they are new. */
export async function findOrCreateClient(db, workspace, values) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await findClientByEmail(db, workspace, values.email);
    if (existing) return { client: existing, existed: true };
    const created = await createClient(db, workspace, values);
    if (created) return { client: created, existed: false };
    // Someone added the same email a moment ago (a double submit, say): look again and use that client.
  }
  throw Object.assign(new Error("Client email kept changing."), { code: "busy" });
}

/** Saves client details. Returns { client }, { conflict: true } for a taken email, or null. */
export async function updateClient(db, workspace, id, values) {
  const client = await getClient(db, workspace, id);
  if (!client) return null;
  try {
    const updated = await db.collection("clients").update(id, {
      name: values.name,
      company: values.company,
      email: values.email,
      address: values.address,
      notes: values.notes
    });
    return { client: updated };
  } catch (error) {
    if (isUniqueConflict(error)) return { conflict: true };
    throw error;
  }
}

/** How many quotes and invoices a client has, counting at most `upTo`. */
export async function countClientDocuments(db, workspace, clientId, upTo = 1) {
  const result = await db.collection("documents").list({ where: { workspace, client_id: clientId }, limit: upTo });
  return result.rows.length;
}

/** A client can be deleted once they have no quotes or invoices. */
export async function clientHasDocuments(db, workspace, clientId) {
  return (await countClientDocuments(db, workspace, clientId)) > 0;
}

export async function deleteClient(db, workspace, id) {
  const client = await getClient(db, workspace, id);
  if (!client || (await clientHasDocuments(db, workspace, id))) return null;
  await db.collection("clients").delete(id);
  return client;
}

// ---------------------------------------------------------------------------
// Document lists

// Newest first: by issue date, then by number. New requests have no date yet
// and come last; the desk lists them separately.
const NEWEST_FIRST = [
  { field: "issue_date", direction: "desc" },
  { field: "number", direction: "desc" }
];

// `where` matches exact values only, so a view that leaves some rows out (the
// Quotes tab skips new requests, which have their own tab) also has a `keep` test.
const VIEWS = {
  all: { where: {} },
  quotes: { where: { kind: "quote" }, keep: (row) => row.status !== "requested" },
  invoices: { where: { kind: "invoice" } },
  requests: { where: { kind: "quote", status: "requested" } }
};

/** One page of the desk's document list for a view: all, quotes, invoices, or requests. */
export async function listDocumentsPage(db, workspace, { view = "all", clientId = null, cursor = null } = {}) {
  const { where: filter, keep } = VIEWS[view] ?? VIEWS.all;
  const where = { workspace, ...filter, ...(clientId ? { client_id: clientId } : {}) };
  return await listPage(db.collection("documents"), { where, order_by: NEWEST_FIRST }, cursor, keep);
}

/** Every document of one kind in one status, such as all sent invoices. */
export async function listByStatus(db, workspace, kind, status) {
  return await listEvery(db.collection("documents"), { where: { workspace, kind, status } });
}

export async function getDocument(db, workspace, id) {
  if (!isId(id)) return null;
  const row = await db.collection("documents").get(id);
  return row && row.workspace === workspace ? row : null;
}

/** Looks up a document by its private client link. Drafts and requests stay hidden. */
export async function getDocumentByToken(db, token) {
  if (!isToken(token)) return null;
  const result = await db.collection("documents").list({ where: { public_token: token }, limit: 1 });
  const row = result.rows[0] ?? null;
  return row && CLIENT_VISIBLE.has(row.status) ? row : null;
}

/** How many quote requests are waiting for a reply, counting at most `upTo`. */
export async function countPendingRequests(db, workspace, { clientId = null, upTo = 100 } = {}) {
  const where = { workspace, kind: "quote", status: "requested", ...(clientId ? { client_id: clientId } : {}) };
  const result = await db.collection("documents").list({ where, limit: Math.min(100, upTo) });
  return result.rows.length;
}

// ---------------------------------------------------------------------------
// Document numbers

export function formatNumber(kind, value) {
  return `${STUDIO.numbering[kind].prefix}${String(value).padStart(4, "0")}`;
}

function numberValue(kind, number) {
  const { prefix } = STUDIO.numbering[kind];
  const digits = String(number ?? "").startsWith(prefix) ? String(number).slice(prefix.length) : "";
  return /^\d+$/.test(digits) ? Number(digits) : 0;
}

/** The number to show: a converted invoice's placeholder shows as "Number pending". */
export function displayNumber(document) {
  return String(document.number ?? "").startsWith(PENDING_NUMBER) ? "Number pending" : document.number;
}

/**
 * The highest number in use for a kind. Numbers sort as text, so the quick
 * check reads the top of the sorted list; `everything` reads every number
 * (needed once numbers grow past four digits and stop sorting in order).
 */
async function highestNumber(db, workspace, kind, { everything = false } = {}) {
  const query = { where: { workspace, kind }, order_by: [{ field: "number", direction: "desc" }] };
  const rows = everything ? await listEvery(db.collection("documents"), query) : (await db.collection("documents").list({ ...query, limit: 25 })).rows;
  return rows.reduce((max, row) => Math.max(max, numberValue(kind, row.number)), STUDIO.numbering[kind].start);
}

/**
 * Runs `write(number)` with the next free number, trying the one after when
 * the unique index says another request just took it.
 */
async function withNextNumber(db, workspace, kind, write) {
  let next = (await highestNumber(db, workspace, kind)) + 1;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      return await write(formatNumber(kind, next));
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      next = attempt === 3 ? Math.max(next + 1, (await highestNumber(db, workspace, kind, { everything: true })) + 1) : next + 1;
    }
  }
  // Only a flood of saves at the same moment gets here. Callers show a "try again" message.
  throw Object.assign(new Error("No free document number found."), { code: "busy" });
}

// ---------------------------------------------------------------------------
// Documents

function documentRow(workspace, kind, fields, now) {
  const issueDate = fields.issue_date || today(now);
  const defaultDays = kind === "quote" ? STUDIO.quoteValidDays : STUDIO.paymentTermsDays;
  const totals = computeTotals(fields.lines ?? [], fields.taxPercent ?? STUDIO.defaultTaxPercent);
  return {
    workspace,
    kind,
    status: fields.status ?? "draft",
    client_id: fields.client_id,
    title: fields.title,
    issue_date: fields.status === "requested" ? "" : issueDate,
    due_date: fields.status === "requested" ? "" : fields.due_date || addDays(issueDate, defaultDays),
    ...totals,
    tax_percent: fields.taxPercent ?? STUDIO.defaultTaxPercent,
    currency: STUDIO.currency,
    notes: fields.notes ?? (kind === "quote" ? STUDIO.quoteNotes : STUDIO.invoiceNotes),
    request_message: fields.request_message ?? "",
    request_note: fields.request_note ?? "",
    public_token: randomToken(),
    quote_id: fields.quote_id ?? "",
    invoice_id: "",
    sent_on: fields.sent_on ?? "",
    accepted_on: fields.accepted_on ?? "",
    paid_on: fields.paid_on ?? ""
  };
}

/**
 * Creates a quote or invoice with the next number. `fields` holds the parsed
 * form values plus `lines` and `taxPercent`; totals are computed here.
 */
export async function createDocument(db, workspace, kind, fields, { now = new Date() } = {}) {
  const row = documentRow(workspace, kind, fields, now);
  return await withNextNumber(db, workspace, kind, async (number) => await db.collection("documents").create({ ...row, number }));
}

/** Saves edits to a draft (or a new request being priced, which becomes a draft). */
export async function updateDocument(db, workspace, id, fields, { now = new Date() } = {}) {
  const document = await getDocument(db, workspace, id);
  if (!document || !isEditable(document)) return null;
  // A blank date means today, the same as for a new document (parseDocumentForm checks the due date against it).
  const issueDate = fields.issue_date || today(now);
  const defaultDays = document.kind === "quote" ? STUDIO.quoteValidDays : STUDIO.paymentTermsDays;
  return await db.collection("documents").update(id, {
    status: document.status === "requested" ? "draft" : document.status,
    client_id: fields.client_id,
    title: fields.title,
    issue_date: issueDate,
    due_date: fields.due_date || addDays(issueDate, defaultDays),
    ...computeTotals(fields.lines, fields.taxPercent),
    tax_percent: fields.taxPercent,
    notes: fields.notes
  });
}

export function isEditable(document) {
  return document.status === "draft" || document.status === "requested";
}

export function hasLines(document) {
  return Array.isArray(document.line_items) && document.line_items.length > 0;
}

/** Status changes the owner can make now. A document needs priced lines before it is sent. */
export function allowedTransitions(document) {
  const moves = TRANSITIONS[document.kind]?.[document.status] ?? [];
  return hasLines(document) ? moves : moves.filter((status) => status !== "sent");
}

export function canConvert(document) {
  return document.kind === "quote" && (document.status === "sent" || document.status === "accepted") && !document.invoice_id && hasLines(document);
}

/** Quotes that were never sent can be deleted, for example spam requests. Invoices are voided instead. */
export function canDelete(document) {
  return document.kind === "quote" && ["requested", "draft", "declined"].includes(document.status) && !document.sent_on && !document.invoice_id;
}

/** True when a sent invoice is past its due date. */
export function isOverdue(document, now = new Date()) {
  return document.kind === "invoice" && document.status === "sent" && Boolean(document.due_date) && document.due_date < today(now);
}

/** True when a sent quote is past its "valid until" date. Clients can no longer accept it. */
export function isExpired(document, now = new Date()) {
  return document.kind === "quote" && document.status === "sent" && Boolean(document.due_date) && document.due_date < today(now);
}

function statusPatch(document, status, now) {
  const date = today(now);
  const patch = { status };
  if (status === "sent" && !document.sent_on) patch.sent_on = date;
  if (status === "accepted") patch.accepted_on = date;
  if (status === "paid") patch.paid_on = date;
  if (document.status === "paid" && status !== "paid") patch.paid_on = "";
  if (document.status === "accepted" && status !== "accepted") patch.accepted_on = "";
  return patch;
}

/**
 * A quote that has an invoice stays "converted". If a status change raced a
 * conversion and landed after it, put the status back.
 */
async function keepConverted(db, updated) {
  if (updated.kind !== "quote") return updated;
  const current = await db.collection("documents").get(updated.id);
  if (current?.invoice_id && current.status !== "converted") return await db.collection("documents").update(updated.id, { status: "converted" });
  return current ?? updated;
}

/** Owner status change. Returns { document } or { error: "not-allowed" | "needs-lines" }. */
export async function changeStatus(db, workspace, id, status, { now = new Date() } = {}) {
  const document = await getDocument(db, workspace, id);
  if (!document) return { error: "not-allowed" };
  if (!allowedTransitions(document).includes(status)) {
    return { error: status === "sent" && (TRANSITIONS[document.kind]?.[document.status] ?? []).includes("sent") ? "needs-lines" : "not-allowed" };
  }
  const updated = await db.collection("documents").update(id, statusPatch(document, status, now));
  return { document: await keepConverted(db, updated) };
}

/** Client answer on a sent quote, through the private link. Returns { document } or { error }. */
export async function respondToQuote(db, token, answer, { now = new Date() } = {}) {
  if (answer !== "accept" && answer !== "decline") return { error: "not-allowed" };
  const document = await getDocumentByToken(db, token);
  if (!document || document.kind !== "quote" || document.status !== "sent" || document.invoice_id) return { error: "not-allowed" };
  if (isExpired(document, now)) return { error: "expired" };
  const updated = await db.collection("documents").update(document.id, statusPatch(document, answer === "accept" ? "accepted" : "declined", now));
  return { document: await keepConverted(db, updated) };
}

/**
 * Turns a sent or accepted quote into a draft invoice with the same client,
 * title, line items, and tax. Returns { invoice, already } or { error }.
 *
 * A quote converts once, even when two requests arrive together (a double
 * click, or two tabs). The new invoice is first saved with a placeholder
 * number made from the quote's id, and the unique number index lets only one
 * request save it. The winner marks the quote as converted and then gives the
 * invoice its real number. A request that saves its placeholder after the
 * winner already renamed its own sees the quote's invoice_id and removes its copy.
 */
export async function convertQuote(db, workspace, id, { now = new Date() } = {}) {
  const documents = db.collection("documents");
  const quote = await getDocument(db, workspace, id);
  if (!quote || quote.kind !== "quote") return { error: "not-allowed" };
  if (quote.invoice_id) return { invoice: await getDocument(db, workspace, quote.invoice_id), already: true };
  if (!canConvert(quote)) return { error: hasLines(quote) ? "not-allowed" : "needs-lines" };

  const placeholder = `${PENDING_NUMBER}${quote.id}`;
  const row = documentRow(workspace, "invoice", { client_id: quote.client_id, title: quote.title, lines: quote.line_items, taxPercent: quote.tax_percent, notes: STUDIO.invoiceNotes, quote_id: quote.id, status: "draft" }, now);
  let invoice;
  try {
    invoice = await documents.create({ ...row, number: placeholder });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    // Another request is converting this quote right now: show its invoice.
    const pending = await documents.list({ where: { workspace, kind: "invoice", number: placeholder }, limit: 1 });
    const latest = await getDocument(db, workspace, quote.id);
    const invoiceId = pending.rows[0]?.id ?? latest?.invoice_id;
    return invoiceId ? { invoice: await getDocument(db, workspace, invoiceId), already: true } : { error: "not-allowed" };
  }

  const latest = await getDocument(db, workspace, quote.id);
  if (!latest || latest.invoice_id || !(latest.status === "sent" || latest.status === "accepted")) {
    await documents.delete(invoice.id);
    return latest?.invoice_id ? { invoice: await getDocument(db, workspace, latest.invoice_id), already: true } : { error: "not-allowed" };
  }
  await documents.update(quote.id, { status: "converted", invoice_id: invoice.id, accepted_on: latest.accepted_on || today(now) });
  invoice = await withNextNumber(db, workspace, "invoice", async (number) => await documents.update(invoice.id, { number }));
  return { invoice, already: false };
}

/**
 * Deletes a quote that was never sent. For a new request whose client has
 * nothing else on file (usually spam), the client is deleted too.
 */
export async function deleteDocument(db, workspace, id) {
  const document = await getDocument(db, workspace, id);
  if (!document || !canDelete(document)) return null;
  await db.collection("documents").delete(id);
  let clientRemoved = false;
  if (document.status === "requested" && !(await clientHasDocuments(db, workspace, document.client_id))) {
    clientRemoved = Boolean(await deleteClient(db, workspace, document.client_id));
  }
  return { document, clientRemoved };
}

// ---------------------------------------------------------------------------
// Public quote requests

/**
 * Saves a quote request from the public form: the client (found by email, or
 * added) and a quote waiting to be priced. Returns { quote, client } or
 * { refused: "full" | "client", waiting } when a cap in LIMITS is reached.
 *
 * The caps hold even when a bot sends many requests at the same moment. A
 * count taken before saving can't see requests that are being saved alongside
 * it, so each request counts again after it is saved and takes itself back out
 * if it went over. The last request saved always sees every other one, so no
 * more than the cap can stay. Anything this request added is removed again when
 * it is refused or fails, so refused requests leave no rows behind.
 *
 * `maxDocuments` optionally caps all quotes and invoices in the workspace too.
 */
export async function createRequest(db, workspace, { values, title }, { maxDocuments = null } = {}) {
  const cap = LIMITS.pendingRequests;
  const perClient = LIMITS.requestsPerClient;
  if ((await countPendingRequests(db, workspace, { upTo: cap })) >= cap) return { refused: "full", waiting: cap };
  if (maxDocuments !== null && (await countDocuments(db, workspace, maxDocuments)) >= maxDocuments) return { refused: "documents", waiting: maxDocuments };

  const { client, existed } = await findOrCreateClient(db, workspace, { name: values.name, company: values.company, email: values.email });
  let quote = null;
  const undo = async () => {
    if (quote) await db.collection("documents").delete(quote.id);
    if (!existed) await deleteClient(db, workspace, client.id);
  };
  try {
    if (existed) {
      const theirs = await countPendingRequests(db, workspace, { clientId: client.id, upTo: perClient });
      if (theirs >= perClient) return { refused: "client", waiting: theirs };
    }
    // Anyone can type a client's email, so flag a request whose name doesn't match the client on file.
    const differs = existed && (client.name.toLowerCase() !== values.name.toLowerCase() || (values.company && client.company.toLowerCase() !== values.company.toLowerCase()));
    quote = await createDocument(db, workspace, "quote", {
      client_id: client.id,
      title,
      status: "requested",
      lines: [],
      request_message: values.message,
      request_note: differs ? `Sent with this client's email but the name "${values.name}"${values.company ? ` and business "${values.company}"` : ""}. Check with the client that the request is theirs.` : ""
    });
    // Count again, now that this request is saved (see above).
    const [all, theirs, documents] = await Promise.all([
      countPendingRequests(db, workspace, { upTo: cap + 1 }),
      countPendingRequests(db, workspace, { clientId: client.id, upTo: perClient + 1 }),
      maxDocuments !== null ? countDocuments(db, workspace, maxDocuments + 1) : 0
    ]);
    const refused = all > cap ? "full" : theirs > perClient ? "client" : maxDocuments !== null && documents > maxDocuments ? "documents" : null;
    if (refused) {
      await undo();
      return { refused, waiting: refused === "client" ? perClient : refused === "full" ? cap : maxDocuments };
    }
    return { quote, client };
  } catch (error) {
    await undo().catch(() => {});
    throw error;
  }
}

/** How many quotes and invoices a workspace has, counting at most `upTo`. */
async function countDocuments(db, workspace, upTo) {
  let count = 0;
  let cursor;
  do {
    const page = await db.collection("documents").list({ where: { workspace }, limit: Math.min(100, upTo - count), ...(cursor ? { cursor } : {}) });
    count += page.rows.length;
    cursor = page.cursor;
  } while (cursor && count < upTo);
  return count;
}

// ---------------------------------------------------------------------------
// Desk overview

/**
 * Figures for the desk overview, read with one query per status so the totals
 * cover every document, not just the first page.
 */
export async function summarize(db, workspace, now = new Date()) {
  const since = addDays(today(now), -30);
  const documents = db.collection("documents");
  const [invoicesOut, sentQuotes, acceptedQuotes, requests, paid] = await Promise.all([
    listByStatus(db, workspace, "invoice", "sent"),
    listByStatus(db, workspace, "quote", "sent"),
    listByStatus(db, workspace, "quote", "accepted"),
    listByStatus(db, workspace, "quote", "requested"),
    listWhile(documents, { where: { workspace, kind: "invoice", status: "paid" }, order_by: [{ field: "paid_on", direction: "desc" }] }, (row) => row.paid_on >= since)
  ]);
  const sum = (rows) => rows.reduce((total, row) => total + row.total_cents, 0);
  const overdue = invoicesOut.filter((row) => isOverdue(row, now));
  const openQuotes = [...sentQuotes, ...acceptedQuotes];
  return {
    outstanding: { cents: sum(invoicesOut), count: invoicesOut.length },
    overdue: { cents: sum(overdue), count: overdue.length },
    openQuotes: { cents: sum(openQuotes), count: openQuotes.length },
    paid30: { cents: sum(paid), count: paid.length },
    requests: requests.length,
    requestRows: requests.sort((a, b) => a.number.localeCompare(b.number)),
    unpaidInvoices: invoicesOut
  };
}

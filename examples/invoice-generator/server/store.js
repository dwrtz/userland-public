// Data access, validation, and money math for clients, quotes, and invoices.
//
// Every row carries a `workspace` field. A normal app keeps all of its rows in
// the "main" workspace; the public demo gives each visitor a separate workspace
// (see demo.js) so visitors never see each other's data.
//
// Money is always whole cents (integers). Totals are computed on the server and
// stored with the document, so a printed invoice never depends on browser math.

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
  maxTaxPercent: 50
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

/** Parses "1,250.50" or "$1250.5" into cents. Returns null when invalid. */
export function parseMoney(value) {
  const text = String(value ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
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
// Money math

export function computeTotals(lineItems, taxPercent) {
  const items = lineItems.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unit_cents: item.unit_cents,
    amount_cents: Math.round(item.quantity * item.unit_cents)
  }));
  const subtotal = items.reduce((sum, item) => sum + item.amount_cents, 0);
  const tax = Math.round((subtotal * taxPercent) / 100);
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
// Queries

async function listAll(collection, where) {
  const rows = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const result = await collection.list({ where, limit: 100, ...(cursor ? { cursor } : {}) });
    rows.push(...result.rows);
    cursor = result.cursor;
    if (!cursor) break;
  }
  return rows;
}

export async function listClients(db, workspace) {
  const rows = await listAll(db.collection("clients"), { workspace });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
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

export async function createClient(db, workspace, values) {
  return await db.collection("clients").create({
    workspace,
    name: values.name,
    company: values.company ?? "",
    email: values.email,
    address: values.address ?? "",
    notes: values.notes ?? ""
  });
}

export async function updateClient(db, workspace, id, values) {
  const client = await getClient(db, workspace, id);
  if (!client) return null;
  return await db.collection("clients").update(id, {
    name: values.name,
    company: values.company,
    email: values.email,
    address: values.address,
    notes: values.notes
  });
}

export async function listDocuments(db, workspace, where = {}) {
  const rows = await listAll(db.collection("documents"), { workspace, ...where });
  // Newest first: sort by issue date, then by number.
  return rows.sort((a, b) => (b.issue_date || "9999").localeCompare(a.issue_date || "9999") || b.number.localeCompare(a.number));
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

export async function countRows(db, workspace) {
  const [clients, documents] = await Promise.all([
    listAll(db.collection("clients"), { workspace }),
    listAll(db.collection("documents"), { workspace })
  ]);
  return { clients: clients.length, documents: documents.length };
}

// ---------------------------------------------------------------------------
// Documents

async function nextNumber(db, workspace, kind) {
  const { prefix, start } = STUDIO.numbering[kind];
  const rows = await listAll(db.collection("documents"), { workspace, kind });
  const highest = rows.reduce((max, row) => {
    const value = Number.parseInt(String(row.number).slice(prefix.length), 10);
    return Number.isFinite(value) && value > max ? value : max;
  }, start);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}

/**
 * Creates a quote or invoice. `fields` holds the parsed form values plus
 * `lines` and `taxPercent`; totals are computed here.
 */
export async function createDocument(db, workspace, kind, fields, { now = new Date() } = {}) {
  const issueDate = fields.issue_date || today(now);
  const defaultDays = kind === "quote" ? STUDIO.quoteValidDays : STUDIO.paymentTermsDays;
  const totals = computeTotals(fields.lines ?? [], fields.taxPercent ?? STUDIO.defaultTaxPercent);
  return await db.collection("documents").create({
    workspace,
    kind,
    number: await nextNumber(db, workspace, kind),
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
    public_token: randomToken(),
    quote_id: fields.quote_id ?? "",
    invoice_id: "",
    sent_on: fields.sent_on ?? "",
    accepted_on: fields.accepted_on ?? "",
    paid_on: fields.paid_on ?? ""
  });
}

/** Saves edits to a draft (or a new request being priced, which becomes a draft). */
export async function updateDocument(db, workspace, id, fields, { now = new Date() } = {}) {
  const document = await getDocument(db, workspace, id);
  if (!document || !isEditable(document)) return null;
  const issueDate = fields.issue_date || document.issue_date || today(now);
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

export function allowedTransitions(document) {
  return TRANSITIONS[document.kind]?.[document.status] ?? [];
}

export function canConvert(document) {
  return document.kind === "quote" && (document.status === "sent" || document.status === "accepted");
}

/** True when a sent invoice is past its due date. */
export function isOverdue(document, now = new Date()) {
  return document.kind === "invoice" && document.status === "sent" && Boolean(document.due_date) && document.due_date < today(now);
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

/** Owner status change. Returns the updated row, or null when the move isn't allowed. */
export async function changeStatus(db, workspace, id, status, { now = new Date() } = {}) {
  const document = await getDocument(db, workspace, id);
  if (!document || !allowedTransitions(document).includes(status)) return null;
  return await db.collection("documents").update(id, statusPatch(document, status, now));
}

/** Client answer on a sent quote, through the private link. */
export async function respondToQuote(db, token, answer, { now = new Date() } = {}) {
  const document = await getDocumentByToken(db, token);
  if (!document || document.kind !== "quote" || document.status !== "sent") return null;
  const status = answer === "accept" ? "accepted" : "declined";
  return await db.collection("documents").update(document.id, statusPatch(document, status, now));
}

/**
 * Turns a sent or accepted quote into a draft invoice with the same client,
 * title, line items, and tax. Runs in a transaction so a quote converts once.
 */
export async function convertQuote(db, workspace, id, { now = new Date() } = {}) {
  return await db.transaction(async (tx) => {
    const quote = await getDocument(tx, workspace, id);
    if (!quote || !canConvert(quote)) return null;
    const invoice = await createDocument(
      tx,
      workspace,
      "invoice",
      {
        client_id: quote.client_id,
        title: quote.title,
        lines: quote.line_items,
        taxPercent: quote.tax_percent,
        notes: STUDIO.invoiceNotes,
        quote_id: quote.id,
        status: "draft"
      },
      { now }
    );
    await tx.collection("documents").update(quote.id, {
      status: "converted",
      invoice_id: invoice.id,
      accepted_on: quote.accepted_on || today(now)
    });
    return invoice;
  });
}

/** Figures for the desk overview. */
export function summarize(documents, now = new Date()) {
  const since = addDays(today(now), -30);
  const sum = (rows) => rows.reduce((total, row) => total + row.total_cents, 0);
  const invoicesOut = documents.filter((row) => row.kind === "invoice" && row.status === "sent");
  const overdue = invoicesOut.filter((row) => isOverdue(row, now));
  const openQuotes = documents.filter((row) => row.kind === "quote" && (row.status === "sent" || row.status === "accepted"));
  const paid = documents.filter((row) => row.kind === "invoice" && row.status === "paid" && row.paid_on >= since);
  return {
    outstanding: { cents: sum(invoicesOut), count: invoicesOut.length },
    overdue: { cents: sum(overdue), count: overdue.length },
    openQuotes: { cents: sum(openQuotes), count: openQuotes.length },
    paid30: { cents: sum(paid), count: paid.length },
    requests: documents.filter((row) => row.status === "requested").length
  };
}

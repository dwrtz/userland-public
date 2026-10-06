// Demo mode for the public demo at https://invoice-demo.apps.userland.fun/.
//
// On the hosts in DEMO_HOSTS, anyone can open the studio desk without signing
// in. Each visitor gets a private demo workspace named by a random key that
// travels in the page address (?demo=...). Userland only passes its own sign-in
// cookie to app code, so links and forms carry the key instead of a cookie.
// A new workspace starts with the fictional sample clients and documents below,
// and the "clear-demo" job deletes it six hours later.
//
// Only keys this server handed out open a desk: a key starts with the time it
// was issued, and its workspace must exist. A made-up or expired key gets the
// start page, so nobody can share a link to a workspace they chose and read
// what visitors type into it.
//
// Nothing here runs on any other host, so a copy of this example published at
// its own address always requires the owner sign-in. The one exception is the
// demo app's own Userland address (SHOWCASE_HOSTS): its public pages send
// visitors to the demo address, and its desk keeps the normal owner sign-in.
// Both lists hold the address on apps.userland.fun and on userland.link (where
// Userland apps are moving), and the app's own address sends visitors to the
// demo address on the same domain.
//
// To remove demo mode from your copy:
//   1. Delete this file and tests/demo.test.ts.
//   2. In server/index.js, delete every line marked `// demo`.
//   3. In manifest.userland.json, delete the "clear-demo" job.

import { STUDIO } from "./studio.js";
import { MAIN_WORKSPACE, addDays, createClient, createDocument, formatNumber, randomToken, today } from "./store.js";
import { esc, messagePage } from "./views.js";

export const DEMO_HOSTS = new Set(["invoice-demo.apps.userland.fun", "invoice-demo.userland.link"]);
export const SHOWCASE_HOSTS = new Set(["3ls259ymzm94r65h4v4.apps.userland.fun", "3ls259ymzm94r65h4v4.userland.link"]);
const DEMO_NAME = "invoice-demo";

/** The demo address on the same domain as a SHOWCASE_HOSTS host. */
function demoOrigin(hostname) {
  return `https://${DEMO_NAME}.${hostname.slice(hostname.indexOf(".") + 1)}`;
}
export const DEMO_ROBOTS = "noindex,follow";
export const EXAMPLE_PAGE = "https://userland.fun/examples/invoice-generator/";

// A key is the issue time (seconds, base 36, 7 characters) plus 16 random characters.
const KEY_PATTERN = /^[0-9a-z]{7}[A-Za-z0-9_-]{16}$/;
const WORKSPACE_PREFIX = "demo-";
const CLEAR_AFTER_SECONDS = 6 * 60 * 60;

// Caps per visitor so the public demo can't be used to store lots of data.
export const DEMO_LIMITS = { clients: 25, documents: 40 };

// At most this many demo desks are open at once. When all of them are taken, a
// new visitor's desk replaces the oldest one that has been open for at least
// MIN_DESK_SECONDS, so a burst of new desks can't lock everyone else out for
// six hours. If every desk is newer than that, visitors see a "busy" page.
export const MAX_OPEN_DESKS = 50;
export const MIN_DESK_SECONDS = 60 * 60;

// Each "clear-demo" run also deletes up to this many rows left behind by
// workspaces whose own cleanup never ran.
const SWEEP_ROWS = 60;

const BUSY_MESSAGE = "A lot of people are trying the demo right now. Please try again in a few minutes.";

/**
 * Called for every request. Outside the demo hosts it returns the request
 * context unchanged. On a demo host it switches to the visitor's workspace
 * (or to none yet, when the address has no valid key) and adds demo page chrome.
 */
export function applyDemo(rc) {
  if (SHOWCASE_HOSTS.has(rc.url.hostname)) return { ...rc, showcase: true, robots: DEMO_ROBOTS, footer: demoFooter() };
  if (!DEMO_HOSTS.has(rc.url.hostname)) return rc;
  const key = rc.url.searchParams.get("demo");
  return withKey(rc, key && KEY_PATTERN.test(key) ? key : null);
}

/**
 * Drops a key that this server didn't issue, or whose workspace was cleared.
 * The visitor then sees the start page instead of an empty, never-cleared desk.
 */
export async function checkKey(rc, ctx, now = new Date()) {
  if (!rc.demo || !rc.workspace) return rc;
  const key = rc.workspace.slice(WORKSPACE_PREFIX.length);
  if (!isExpired(rc.workspace, now)) {
    const rows = await ctx.data.collection("documents").list({ where: { workspace: rc.workspace }, limit: 1 });
    if (rows.rows.length > 0) return rc;
  }
  return { ...withKey(rc, null), keyCleared: Boolean(key) };
}

/** Where a public page on the app's own Userland address sends the visitor. */
export function showcaseTarget(rc, method) {
  const origin = demoOrigin(rc.url.hostname);
  return method === "GET" ? origin + rc.url.pathname + rc.url.search : `${origin}/`;
}

/**
 * Opens a new workspace for this visitor and returns the updated request
 * context. When the demo is full or cleanup can't be scheduled, the context
 * has no workspace and `demoBusy` holds a message for the visitor.
 */
export async function openWorkspace(rc, ctx) {
  const result = await startDemo(ctx);
  return result.key ? withKey(rc, result.key) : { ...withKey(rc, null), demoBusy: result.busy };
}

function withKey(rc, key) {
  return {
    ...rc,
    demo: true,
    workspace: key ? WORKSPACE_PREFIX + key : null,
    link: (path) => demoLink(path, key),
    robots: DEMO_ROBOTS,
    banner: (section) => demoBanner(section, key),
    footer: demoFooter(),
    signOut: false
  };
}

/** Adds the visitor's key to an app path so the next page opens the same workspace. */
export function demoLink(path, key) {
  if (!key) return path;
  const [base, hash = ""] = path.split("#");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}demo=${key}${hash ? `#${hash}` : ""}`;
}

function newKey(now) {
  return Math.floor(now.getTime() / 1000).toString(36).padStart(7, "0") + randomToken(12);
}

/** When a demo workspace was opened, in milliseconds, or null for an old-style key. */
function openedAt(workspace) {
  const key = workspace.slice(WORKSPACE_PREFIX.length);
  return KEY_PATTERN.test(key) ? Number.parseInt(key.slice(0, 7), 36) * 1000 : null;
}

/** True for a demo workspace older than six hours, or one named with an old-style key. */
function isExpired(workspace, now) {
  if (!workspace.startsWith(WORKSPACE_PREFIX)) return false;
  const opened = openedAt(workspace);
  return opened === null || opened + CLEAR_AFTER_SECONDS * 1000 <= now.getTime();
}

// Every workspace gets the sample paid invoice first, so it always holds the
// first invoice number. Listing that number across workspaces lists open desks.
const MARKER = formatNumber("invoice", STUDIO.numbering.invoice.start + 1);

/** Open (not yet expired) demo workspaces, oldest first. Reads every page. */
async function openDesks(ctx, now) {
  const desks = new Set();
  let cursor;
  do {
    const page = await ctx.data.collection("documents").list({ where: { kind: "invoice", number: MARKER }, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) if (row.workspace.startsWith(WORKSPACE_PREFIX) && !isExpired(row.workspace, now)) desks.add(row.workspace);
    cursor = page.cursor;
  } while (cursor);
  return [...desks].sort((a, b) => openedAt(a) - openedAt(b));
}

/**
 * Creates a new visitor workspace with sample data. The cleanup job is
 * scheduled first: if it can't be (for example, the month's job runs are used
 * up), no workspace is created. Returns { key } or { busy: message }.
 *
 * The desk cap holds even when many visitors start at the same moment: a count
 * taken first can't see desks being opened alongside it, so each new desk counts
 * again once its first sample invoice is saved, and clears itself if it went over.
 */
export async function startDemo(ctx, now = new Date()) {
  const desks = await openDesks(ctx, now);
  if (desks.length >= MAX_OPEN_DESKS) {
    const oldest = desks[0];
    if (openedAt(oldest) + MIN_DESK_SECONDS * 1000 > now.getTime()) {
      await ctx.log.warn("demo is full", { limit: MAX_OPEN_DESKS });
      return { busy: BUSY_MESSAGE };
    }
    await clearWorkspace(ctx, oldest);
    await ctx.log.info("oldest demo workspace replaced", {});
  }
  const key = newKey(now);
  const workspace = WORKSPACE_PREFIX + key;
  try {
    await ctx.jobs.enqueue("clear-demo", { workspace }, { delay_seconds: CLEAR_AFTER_SECONDS });
  } catch (error) {
    await ctx.log.warn("demo cleanup not scheduled", { reason: error instanceof Error ? error.message : "unknown" });
    return { busy: BUSY_MESSAGE };
  }
  // If a sample write fails, the job above still clears the rest.
  const fits = async () => (await openDesks(ctx, now)).length <= MAX_OPEN_DESKS;
  if (!(await addSamples(ctx.data, workspace, now, fits))) {
    await clearWorkspace(ctx, workspace);
    await ctx.log.warn("demo is full", { limit: MAX_OPEN_DESKS });
    return { busy: BUSY_MESSAGE };
  }
  await ctx.log.info("demo workspace opened", {});
  return { key };
}

/** Deletes every row in one demo workspace. Returns how many were deleted. */
async function clearWorkspace(ctx, workspace) {
  if (!workspace.startsWith(WORKSPACE_PREFIX) || workspace === MAIN_WORKSPACE) return 0;
  let removed = 0;
  for (const name of ["documents", "clients"]) {
    const collection = ctx.data.collection(name);
    // Always read the first page again: the rows just deleted are gone from it.
    for (let page = 0; page < 10; page += 1) {
      const result = await collection.list({ where: { workspace }, limit: 100 });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        await collection.delete(row.id);
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * The "clear-demo" job: deletes one visitor workspace, then sweeps a few rows
 * from any expired workspace whose own job never ran. Never touches real data.
 */
export async function clearDemo(event, ctx, now = new Date()) {
  const workspace = event.payload?.workspace;
  const removed = typeof workspace === "string" ? await clearWorkspace(ctx, workspace) : 0;
  const swept = await sweepExpired(ctx, now);
  await ctx.log.info("demo workspace cleared", { rows: removed, swept });
}

// Reads every row (a Free app holds at most 1,000, so this is a few
// pages), notes the expired demo rows, and deletes up to SWEEP_ROWS of them
// after reading, so deleting never shifts the pages still to be read.
async function sweepExpired(ctx, now) {
  let budget = SWEEP_ROWS;
  for (const name of ["documents", "clients"]) {
    const collection = ctx.data.collection(name);
    const expired = [];
    let cursor;
    do {
      const page = await collection.list({ order_by: [{ field: "workspace", direction: "asc" }], limit: 100, ...(cursor ? { cursor } : {}) });
      for (const row of page.rows) if (isExpired(row.workspace, now)) expired.push(row.id);
      cursor = page.cursor;
    } while (cursor && expired.length < budget);
    for (const id of expired.slice(0, budget)) await collection.delete(id);
    budget -= Math.min(budget, expired.length);
    if (budget === 0) break;
  }
  return SWEEP_ROWS - budget;
}

/** Returns a message when this visitor has reached the demo cap, otherwise null. */
export async function limitMessage(ctx, workspace, kind) {
  const limit = DEMO_LIMITS[kind];
  const result = await ctx.data.collection(kind).list({ where: { workspace }, limit: 100 });
  if (result.rows.length < limit) return null;
  return capMessage(kind);
}

/**
 * Called right after a desk save. Saves sent at the same moment all pass
 * limitMessage, so each one counts again here; when the visitor went over the
 * cap, the new row is deleted and the message is returned. Otherwise null.
 */
export async function undoIfOverLimit(ctx, workspace, kind, id) {
  const limit = DEMO_LIMITS[kind];
  const result = await ctx.data.collection(kind).list({ where: { workspace }, limit: limit + 1 });
  if (result.rows.length <= limit) return null;
  await ctx.data.collection(kind).delete(id);
  return capMessage(kind);
}

function capMessage(kind) {
  return `The demo stops at ${DEMO_LIMITS[kind]} ${kind}. Your own app has no limit like this.`;
}

// ---------------------------------------------------------------------------
// Pages and page chrome shown only in the demo.

/** The page shown at /desk before a visitor has a demo desk. */
export function startPage(rc) {
  const message = rc.keyCleared
    ? "That demo desk has been cleared. Demo desks are deleted after six hours, or after an hour when the demo is busy. Open a new one with fresh sample clients, quotes, and invoices."
    : "Open a private copy of the studio desk with sample clients, quotes, and invoices. Price a request, send a quote, and turn it into an invoice.";
  return messagePage(rc, {
    title: "Try the owner's side",
    message,
    actionHtml: `<form method="post" action="/demo/start"><button class="button button-primary" type="submit">Open the studio desk</button></form>`
  });
}

/** The page shown when no new demo desk can be opened right now. */
export function busyPage(rc) {
  return messagePage(rc, { title: "The demo is busy", message: BUSY_MESSAGE, actionHtml: `<p><a href="/">Back to the studio page</a></p>` });
}

export function demoBanner(section, key) {
  const desk = esc(demoLink("/desk", key));
  const home = esc(demoLink("/", key));
  const next =
    section === "desk"
      ? `<a href="${home}">See the client side</a>`
      : key
        ? `<a href="${desk}">Open the studio desk</a>`
        : `<form method="post" action="/demo/start" class="demo-inline"><button type="submit">Open the studio desk</button></form>`;
  return `<aside class="demo-banner" aria-label="About this demo"><div class="wrap demo-banner-inner"><p><strong>Demo</strong> A sample quote and invoice app for a made-up studio. Anything you add is visible only to you and is cleared after a few hours.</p>${next}</div></aside>`;
}

export function demoFooter() {
  return `<p class="demo-footer">Demo app. Built with Userland. <a href="${EXAMPLE_PAGE}">See how it's made</a></p>`;
}

// ---------------------------------------------------------------------------
// Sample data. Every person and business here is fictional.

const SAMPLE_CLIENTS = [
  { ref: "fieldnote", name: "Marta Ionescu", company: "Fieldnote Coffee Roasters", email: "marta@example.com", address: "418 Alder Street\nPortland, OR 97205" },
  { ref: "brandt", name: "Theo Brandt", company: "Brandt Cycles", email: "theo@example.com", address: "77 Division Street\nPortland, OR 97202" },
  { ref: "juniper", name: "Priya Raman", company: "Juniper & Salt", email: "priya@example.com", address: "1320 Larch Avenue\nPortland, OR 97214" },
  { ref: "okafor", name: "Sam Okafor", company: "Okafor Architects", email: "sam@example.com", address: "5 Pearl Court, Floor 2\nPortland, OR 97209" },
  { ref: "hart", name: "Lena Hart", company: "Hart & Hound Grooming", email: "lena@example.com", address: "" }
];

function sampleDocuments(date) {
  const day = (offset) => addDays(date, offset);
  return [
    {
      kind: "invoice", client: "okafor", status: "paid", title: "Website photography, 12 projects",
      issue_date: day(-44), due_date: day(-30), sent_on: day(-44), paid_on: day(-27),
      lines: [
        { description: "Architectural photography on location", quantity: 3, unit_cents: 140000 },
        { description: "Retouching and color grading, per image", quantity: 60, unit_cents: 1800 },
        { description: "Usage license, web and print, two years", quantity: 1, unit_cents: 60000 }
      ]
    },
    {
      kind: "invoice", client: "brandt", status: "sent", title: "Spring catalog photography",
      issue_date: day(-24), due_date: day(-10), sent_on: day(-24),
      lines: [
        { description: "Studio product photography, per day", quantity: 2, unit_cents: 140000 },
        { description: "Component detail shots, per image", quantity: 40, unit_cents: 3500 },
        { description: "Location day with rider and styling", quantity: 1, unit_cents: 160000 }
      ]
    },
    {
      kind: "quote", client: "juniper", status: "converted", title: "Menu redesign and food photography",
      issue_date: day(-21), due_date: day(9), sent_on: day(-21), accepted_on: day(-14), converts: true,
      lines: [
        { description: "Menu design, four pages", quantity: 1, unit_cents: 240000 },
        { description: "Food photography, half day", quantity: 1, unit_cents: 85000 },
        { description: "Print-ready files and press proof", quantity: 1, unit_cents: 30000 }
      ]
    },
    {
      kind: "quote", client: "fieldnote", status: "sent", title: "Packaging system for three blends",
      issue_date: day(-4), due_date: day(26), sent_on: day(-4),
      lines: [
        { description: "Packaging design, per blend", quantity: 3, unit_cents: 120000 },
        { description: "Label production files", quantity: 1, unit_cents: 45000 },
        { description: "Product photography, half day", quantity: 1, unit_cents: 85000 }
      ]
    },
    {
      kind: "quote", client: "hart", status: "requested", title: "Brand identity",
      request_message: "We're opening a second shop in the spring and need a refreshed logo and signage for both locations. Timing matters more than budget.",
      lines: []
    },
    {
      kind: "quote", client: "okafor", status: "draft", title: "Studio identity refresh",
      issue_date: day(0), due_date: day(30),
      lines: [
        { description: "Logo refinement and type system", quantity: 1, unit_cents: 480000 },
        { description: "Stationery set: cards, letterhead, envelopes", quantity: 1, unit_cents: 95000 }
      ]
    }
  ];
}

// Saves the sample clients and documents. After the first document (the paid
// invoice that marks an open desk), it calls `fits`; when that says the demo is
// full, it stops and returns false.
async function addSamples(db, workspace, now, fits) {
  const clientIds = {};
  for (const client of SAMPLE_CLIENTS) {
    const row = await createClient(db, workspace, { ...client, notes: "" });
    clientIds[client.ref] = row.id;
  }
  for (const sample of sampleDocuments(today(now))) {
    const document = await createDocument(
      db,
      workspace,
      sample.kind,
      {
        ...sample,
        client_id: clientIds[sample.client],
        lines: sample.lines,
        taxPercent: 0
      },
      { now }
    );
    if (document.number === MARKER && !(await fits())) return false;
    if (sample.converts) {
      // The accepted menu quote became an invoice, which is now waiting on payment.
      const invoice = await createDocument(
        db,
        workspace,
        "invoice",
        {
          client_id: document.client_id,
          title: document.title,
          lines: sample.lines,
          taxPercent: 0,
          quote_id: document.id,
          status: "sent",
          issue_date: addDays(today(now), -12),
          due_date: addDays(today(now), 2),
          sent_on: addDays(today(now), -12)
        },
        { now }
      );
      await db.collection("documents").update(document.id, { invoice_id: invoice.id });
    }
  }
  return true;
}

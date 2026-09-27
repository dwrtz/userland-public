// Demo mode for the public demo at https://invoice-demo.apps.userland.fun/.
//
// On the hosts in DEMO_HOSTS, anyone can open the studio desk without signing
// in. Each visitor gets a private demo workspace named by a random key that
// travels in the page address (?demo=...). Userland only passes its own sign-in
// cookie to app code, so links and forms carry the key instead of a cookie.
// A new workspace starts with the fictional sample clients and documents below,
// and the "clear-demo" job deletes it a few hours later.
//
// Nothing here runs on any other host, so a copy of this example published at
// its own address always requires the owner sign-in. The one exception is the
// demo app's own Userland address (SHOWCASE_HOSTS): its public pages send
// visitors to the demo address, and its desk keeps the normal owner sign-in.
//
// To remove demo mode from your copy:
//   1. Delete this file and tests/demo.test.ts.
//   2. In server/index.js, delete every line marked `// demo`.
//   3. In manifest.userland.json, delete the "clear-demo" job.

import { MAIN_WORKSPACE, addDays, createClient, createDocument, randomToken, today } from "./store.js";

export const DEMO_HOSTS = new Set(["invoice-demo.apps.userland.fun"]);
export const SHOWCASE_HOSTS = new Set(["3ls259ymzm94r65h4v4.apps.userland.fun"]);
const DEMO_ORIGIN = "https://invoice-demo.apps.userland.fun";
export const DEMO_ROBOTS = "noindex,follow";
export const EXAMPLE_PAGE = "https://userland.fun/examples/invoice-generator/";

const KEY_PATTERN = /^[A-Za-z0-9_-]{20}$/;
const WORKSPACE_PREFIX = "demo-";
const CLEAR_AFTER_SECONDS = 6 * 60 * 60;

// Caps per visitor so the public demo can't be used to store lots of data.
export const DEMO_LIMITS = { clients: 25, documents: 40 };

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

/** Where a public page on the app's own Userland address sends the visitor. */
export function showcaseTarget(rc, method) {
  return method === "GET" ? DEMO_ORIGIN + rc.url.pathname + rc.url.search : `${DEMO_ORIGIN}/`;
}

/** Opens a new workspace for this visitor and returns the updated request context. */
export async function openWorkspace(rc, ctx) {
  return withKey(rc, await startDemo(ctx));
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

/** Creates a new visitor workspace with sample data and schedules its cleanup. */
export async function startDemo(ctx, now = new Date()) {
  const key = randomToken(15);
  const workspace = WORKSPACE_PREFIX + key;
  await ctx.data.transaction(async (tx) => await addSamples(tx, workspace, now));
  try {
    await ctx.jobs.enqueue("clear-demo", { workspace }, { delay_seconds: CLEAR_AFTER_SECONDS });
  } catch (error) {
    await ctx.log.warn("demo cleanup not scheduled", { reason: error instanceof Error ? error.message : "unknown" });
  }
  await ctx.log.info("demo workspace opened", {});
  return key;
}

/** The "clear-demo" job: deletes one visitor workspace. Never touches real data. */
export async function clearDemo(event, ctx) {
  const workspace = event.payload?.workspace;
  if (typeof workspace !== "string" || !workspace.startsWith(WORKSPACE_PREFIX) || workspace === MAIN_WORKSPACE) return;
  let removed = 0;
  for (const name of ["documents", "clients"]) {
    const collection = ctx.data.collection(name);
    for (let page = 0; page < 10; page += 1) {
      const result = await collection.list({ where: { workspace }, limit: 100 });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        await collection.delete(row.id);
        removed += 1;
      }
    }
  }
  await ctx.log.info("demo workspace cleared", { rows: removed });
}

/** Returns a message when this visitor has reached the demo cap, otherwise null. */
export function demoLimitMessage(counts, kind) {
  const limit = DEMO_LIMITS[kind];
  if (counts[kind] < limit) return null;
  return `The demo stops at ${limit} ${kind}. Your own app has no limit like this.`;
}

// ---------------------------------------------------------------------------
// Page chrome shown only in the demo: a notice at the top and a footer line.

export function demoBanner(section, key) {
  const desk = demoLink("/desk", key);
  const home = demoLink("/", key);
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

async function addSamples(db, workspace, now) {
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
}

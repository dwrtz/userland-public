// DEMO MODE
// ---------------------------------------------------------------------------
// This file exists only for the public demo at mini-crm-demo.apps.userland.fun.
// It lets visitors explore the owner side without signing in, while keeping
// every visitor's entries away from everyone else.
//
// How it works:
// - Each visitor gets a random key the first time they save something. The key
//   travels in the page address (?demo=...), because Userland only forwards
//   its own sign-in cookie to app code.
// - The owner view shows the sample leads below plus only the rows saved with
//   this visitor's key (the demo_visitor field in both collections).
// - Changes to a sample lead are saved as activity rows for this visitor only,
//   so the shared sample leads never change.
// - Visitors without a key see the sample leads and nothing else.
// - The key is the only thing that ties entries to a visitor, so anyone who
//   has a visitor's link sees that visitor's entries. The demo pages ask
//   visitors to use made-up details for that reason.
// - Each visitor can save a limited number of rows, and the whole demo stops
//   taking new entries once it holds DEMO_LIMITS.everyone rows, so the public
//   demo can't grow without bound. Clear old demo rows by hand to reopen it.
//
// To turn demo mode off for a real business:
// 1. Delete this file.
// 2. In server/index.js, delete the `import { demo } from "./demo.js";` line and
//    change the last line to `export default createApp();`.
// 3. In manifest.userland.json, remove the demo_visitor fields and the
//    by_demo_visitor indexes.
// 4. Delete tests/demo.test.ts.
// The owner routes then require a signed-in app user with the owner role.
// ---------------------------------------------------------------------------

import { byNewest, normalizeActivity, normalizeLead } from "./leads.js";

const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Most rows one visitor can save (leads, activity), and most history rows the
 * whole demo holds across all visitors. Every save writes a history row, so
 * `everyone` also caps the total number of demo leads.
 */
export const DEMO_LIMITS = { leads: 25, activity: 90, everyone: 1500 };

/**
 * Thrown when a visitor, or the demo as a whole, hits DEMO_LIMITS.
 * server/index.js shows a friendly page. `scope` is "visitor" or "everyone".
 */
export class DemoLimitError extends Error {
  code = "demo_limit";
  constructor(scope) {
    super(`Demo limit reached (${scope}).`);
    this.scope = scope;
  }
}

/** True when the collection holds at least `count` rows. Pages through list(). */
async function holdsAtLeast(collection, count) {
  let seen = 0;
  let cursor;
  do {
    const page = await collection.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    seen += page.rows.length;
    cursor = page.cursor;
  } while (cursor && seen < count);
  return seen >= count;
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Sample leads. Fictional people with example.com addresses. Times are offsets
// from "now" in minutes so the board always looks current.
const HOUR = 60;
const DAY = 24 * HOUR;

const SAMPLE_LEADS = [
  { id: "sample-maya", ago: 35, name: "Maya Okafor", email: "maya.okafor@example.com", phone: "(555) 010-2231", project: "kitchen", budget: "40k_80k", timeline: "1_3_months", source: "website", stage: "new", follow: null, details: "Galley kitchen in a 1962 ranch. We'd like to open the wall to the dining room and add an island if there's room." },
  { id: "sample-grace", ago: 5 * HOUR, name: "Grace Liu", email: "grace.liu@example.com", phone: "", project: "repairs", budget: "under_15k", timeline: "asap", source: "website", stage: "new", follow: null, details: "Brown water stain on the living room ceiling, right under the upstairs bathroom. Getting bigger." },
  { id: "sample-daniel", ago: 26 * HOUR, name: "Daniel Reyes", email: "d.reyes@example.com", phone: "(555) 010-4418", project: "bathroom", budget: "15k_40k", timeline: "1_3_months", source: "phone", stage: "contacted", follow: 0, details: "Replace the tub in the main bath with a walk-in shower. Wants it done before the holidays." },
  { id: "sample-sofia", ago: 2 * DAY, name: "Sofia Marchetti", email: "sofia.m@example.com", phone: "(555) 010-7702", project: "exterior", budget: "15k_40k", timeline: "3_6_months", source: "website", stage: "contacted", follow: -2, details: "Front porch is sagging on one side. Rebuild with new posts and railings." },
  { id: "sample-priya", ago: 4 * DAY, name: "Priya Natarajan", email: "priya.n@example.com", phone: "(555) 010-3390", project: "basement", budget: "40k_80k", timeline: "3_6_months", source: "referral", stage: "site_visit", follow: 2, details: "Finish the basement: family room, half bath, and an egress window for a guest room." },
  { id: "sample-brennan", ago: 6 * DAY, name: "Tom and Alice Brennan", email: "brennans@example.com", phone: "(555) 010-5127", project: "exterior", budget: "15k_40k", timeline: "1_3_months", source: "website", stage: "quoted", follow: 1, details: "Replace a rotting 300 sq ft deck. Leaning toward composite." },
  { id: "sample-marcus", ago: 9 * DAY, name: "Marcus Webb", email: "marcus.webb@example.com", phone: "(555) 010-8864", project: "addition", budget: "over_80k", timeline: "3_6_months", source: "referral", stage: "quoted", follow: 5, details: "Four-season sunroom off the back of the house, about 14 by 16." },
  { id: "sample-hannah", ago: 16 * DAY, name: "Hannah Kowalski", email: "h.kowalski@example.com", phone: "(555) 010-6645", project: "kitchen", budget: "15k_40k", timeline: "asap", source: "repeat_client", stage: "won", follow: null, details: "New cabinet fronts, quartz counters, and under-cabinet lights. Keeping the layout." },
  { id: "sample-luis", ago: 21 * DAY, name: "Luis Ortega", email: "luis.ortega@example.com", phone: "", project: "bathroom", budget: "under_15k", timeline: "planning", source: "website", stage: "lost", follow: null, details: "Swap the vanity and toilet in the hall bath." }
];

// Sample history: [lead id, minutes ago, kind, stage or body]
const SAMPLE_ACTIVITY = [
  ["sample-maya", 35, "received"],
  ["sample-grace", 5 * HOUR, "received"],
  ["sample-daniel", 26 * HOUR, "added"],
  ["sample-daniel", 25 * HOUR, "stage", "contacted"],
  ["sample-daniel", 25 * HOUR, "note", "Called back same day. Tub is original, tile is sound. Wants a quote before Thanksgiving."],
  ["sample-sofia", 2 * DAY, "received"],
  ["sample-sofia", 40 * HOUR, "stage", "contacted"],
  ["sample-priya", 4 * DAY, "added"],
  ["sample-priya", 3 * DAY, "stage", "contacted"],
  ["sample-priya", 2 * DAY, "stage", "site_visit"],
  ["sample-priya", 2 * DAY - 30, "note", "Walkthrough booked. Check ceiling height near the stairs and where the sump pump sits."],
  ["sample-brennan", 6 * DAY, "received"],
  ["sample-brennan", 5 * DAY, "stage", "site_visit"],
  ["sample-brennan", 5 * DAY - 60, "note", "Measured 14 x 22. Joists are fine; decking and rails need to go."],
  ["sample-brennan", 3 * DAY, "stage", "quoted"],
  ["sample-brennan", 3 * DAY - 5, "note", "Sent two options: composite $24,800 or pressure-treated $19,600."],
  ["sample-marcus", 9 * DAY, "added"],
  ["sample-marcus", 7 * DAY, "stage", "site_visit"],
  ["sample-marcus", 90, "stage", "quoted"],
  ["sample-marcus", 88, "note", "Quote sent: $96,500 including permit drawings. He wants to walk the numbers through with his partner."],
  ["sample-hannah", 16 * DAY, "added"],
  ["sample-hannah", 12 * DAY, "stage", "quoted"],
  ["sample-hannah", 3 * HOUR, "stage", "won"],
  ["sample-hannah", 3 * HOUR - 2, "note", "Deposit received. Cabinet fronts ordered, install week of the 14th."],
  ["sample-luis", 21 * DAY, "received"],
  ["sample-luis", 20 * DAY, "stage", "contacted"],
  ["sample-luis", 18 * DAY, "stage", "lost"],
  ["sample-luis", 18 * DAY - 3, "note", "Going with a handyman for the swap. Offered to help if the floor needs work later."]
];

function minutesAgo(now, minutes) {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function daysFromToday(now, days) {
  const date = new Date(now.getTime() + days * DAY * 60_000);
  return date.toISOString().slice(0, 10);
}

function sampleLeads(now) {
  return SAMPLE_LEADS.map(({ ago, follow, ...lead }) => ({
    ...lead,
    follow_up_on: follow === null ? "" : daysFromToday(now, follow),
    created_at: minutesAgo(now, ago),
    updated_at: minutesAgo(now, ago)
  }));
}

function sampleActivity(now) {
  const names = new Map(SAMPLE_LEADS.map((lead) => [lead.id, lead.name]));
  return SAMPLE_ACTIVITY.map(([leadId, ago, kind, value = ""], index) => ({
    id: `sample-activity-${index}`,
    lead_id: leadId,
    lead_name: names.get(leadId),
    kind,
    stage: kind === "stage" ? value : kind === "received" || kind === "added" ? "new" : "",
    body: kind === "note" ? value : "",
    created_at: minutesAgo(now, ago)
  }));
}

/** Apply this visitor's saved changes to a sample lead. */
function applyChanges(lead, changes) {
  const next = { ...lead };
  for (const change of [...changes].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (change.kind === "stage" && change.stage) next.stage = change.stage;
    if (change.kind === "follow_up") next.follow_up_on = change.body;
    next.updated_at = change.created_at;
  }
  return next;
}

/**
 * A store with the same methods as createStore() in leads.js, limited to the
 * sample leads plus this visitor's own rows. `key` is "" for visitors who
 * haven't saved anything yet; they can read but not write.
 */
function openStore(ctx, key, now = new Date()) {
  const leads = () => ctx.data.collection("leads");
  const activity = () => ctx.data.collection("activity");

  async function ownActivity() {
    if (!key) return [];
    const result = await activity().list({ where: { demo_visitor: key }, limit: 100 });
    return result.rows.map(normalizeActivity);
  }

  async function ownLeads() {
    if (!key) return [];
    const result = await leads().list({ where: { demo_visitor: key }, limit: 100 });
    return result.rows.map(normalizeLead);
  }

  async function allActivity() {
    return [...sampleActivity(now), ...(await ownActivity())].sort(byNewest);
  }

  /**
   * Throw DemoLimitError unless this visitor may save more. Called once before
   * each save, so a save never stops halfway.
   */
  async function assertRoom({ lead = false } = {}) {
    if (!key) throw new Error("Demo writes need a visitor key.");
    if (lead && (await ownLeads()).length >= DEMO_LIMITS.leads) throw new DemoLimitError("visitor");
    if ((await ownActivity()).length >= DEMO_LIMITS.activity) throw new DemoLimitError("visitor");
    if (await holdsAtLeast(activity(), DEMO_LIMITS.everyone)) throw new DemoLimitError("everyone");
  }

  async function record(entry) {
    const row = await activity().create({ ...entry, demo_visitor: key });
    return normalizeActivity(row);
  }

  return {
    async listLeads() {
      const history = await allActivity();
      const samples = sampleLeads(now).map((lead) =>
        applyChanges(
          lead,
          history.filter((entry) => entry.lead_id === lead.id && !entry.id.startsWith("sample-"))
        )
      );
      return [...samples, ...(await ownLeads())].sort(byNewest);
    },

    async getLead(id) {
      if (id.startsWith("sample-")) {
        return (await this.listLeads()).find((lead) => lead.id === id) ?? null;
      }
      if (!key) return null;
      const row = await leads().get(id);
      // Never show a row saved under a different visitor's key.
      return row && row.demo_visitor === key ? normalizeLead(row) : null;
    },

    async createLead(values, { via }) {
      await assertRoom({ lead: true });
      const row = await leads().create({
        name: values.name,
        email: values.email,
        phone: values.phone,
        project: values.project,
        budget: values.budget,
        timeline: values.timeline || undefined,
        details: values.details,
        source: values.source,
        stage: "new",
        follow_up_on: "",
        demo_visitor: key
      });
      await record({ lead_id: row.id, lead_name: values.name, kind: via === "public" ? "received" : "added", stage: "new", body: "" });
      return normalizeLead(row);
    },

    async updateLead(lead, values) {
      const stageChanged = values.stage !== lead.stage;
      const followChanged = values.follow_up_on !== lead.follow_up_on;
      if (stageChanged || followChanged) await assertRoom();
      if (!lead.id.startsWith("sample-") && (stageChanged || followChanged)) {
        await leads().update(lead.id, { stage: values.stage, follow_up_on: values.follow_up_on });
      }
      if (stageChanged) await record({ lead_id: lead.id, lead_name: lead.name, kind: "stage", stage: values.stage, body: "" });
      if (followChanged) await record({ lead_id: lead.id, lead_name: lead.name, kind: "follow_up", body: values.follow_up_on });
      return { ...lead, ...values };
    },

    async addNote(lead, body) {
      await assertRoom();
      return await record({ lead_id: lead.id, lead_name: lead.name, kind: "note", body });
    },

    async listActivity({ leadId, limit = 100 } = {}) {
      const history = await allActivity();
      return (leadId ? history.filter((entry) => entry.lead_id === leadId) : history).slice(0, limit);
    }
  };
}

export const demo = {
  /** The visitor key from ?demo= or a hidden form field, or "" when absent or malformed. */
  keyFrom(url, form = {}) {
    const value = String(form.demo || url.searchParams.get("demo") || "");
    return KEY_PATTERN.test(value) ? value : "";
  },
  newKey,
  openStore
};

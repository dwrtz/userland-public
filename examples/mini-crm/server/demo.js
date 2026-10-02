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
// - Everything a visitor saves is an activity row tagged with their key
//   (demo_visitor) and the time (demo_saved_at). A lead they add is its first
//   row, holding the lead's details; later rows change its stage, set a
//   follow-up, or add a note. The demo never writes to the leads collection.
// - The owner view shows the sample leads below plus this visitor's rows.
//   Changes to a sample lead are rows for this visitor only, so the shared
//   sample leads never change. Visitors without a key see only the samples.
// - The key is the only thing that ties entries to a visitor, so anyone who
//   has a visitor's link sees that visitor's entries. The demo pages ask
//   visitors to use made-up details for that reason.
// - Limits (DEMO_LIMITS): each visitor can save a few leads and entries, and
//   the whole demo takes at most `perHour` entries in any hour. A visitor
//   without a key gets a new one on their first save, so the hourly limit is
//   the one that holds against scripts. Each save checks both first; then,
//   once its entries are saved, it counts the last hour again with them
//   included and takes them back if the count is over `perHour`. The last
//   save to count sees every entry that stays, so the hourly limit holds even
//   when saves arrive at the same moment (a few saves arriving together right
//   at the limit can all be turned away). The per-visitor limits are checked
//   only before saving; a script gets nothing from them anyway.
// - Entries are removed DEMO_KEEP_HOURS after they're saved: every save first
//   deletes a few expired rows (SWEEP_BATCH). With the hourly limit, the demo
//   holds at most perHour x DEMO_KEEP_HOURS rows (720), inside the Free
//   plan's 1,000.
// - The leads collection keeps a demo_visitor field that nothing uses: older
//   versions of the demo saved leads there, and Userland refuses a release
//   that removes a field the live app already has.
//
// Demo mode only turns on for the hostnames in DEMO_HOSTS, so a copy of this
// app published anywhere else runs the real, signed-in owner board and saves
// every lead where the owner sees it.
//
// To remove the demo code from your own copy:
// 1. Delete this file.
// 2. In server/index.js, delete the `import { demo } from "./demo.js";` line and
//    change the last line to `export default createApp();`.
// 3. In manifest.userland.json, remove the demo_visitor field from the leads
//    collection, and in the activity collection remove the demo_visitor and
//    demo_saved_at fields and the by_demo_visitor index. Do this before the
//    first publish: once an app is live, Userland won't release a version that
//    removes a field, so a published copy keeps them (unused).
// 4. Delete tests/demo.test.ts.
// The owner routes then require a signed-in app user with the owner role.
// ---------------------------------------------------------------------------

import { DELETE_BATCH, STAGES, byNewest, byReceived, normalizeActivity, summarizeLeads } from "./leads.js";

// The public demo's short address and the demo app's own address. Both belong
// to the Userland demo deployment only; replace them if you publish your own
// demo.
export const DEMO_HOSTS = new Set(["mini-crm-demo.apps.userland.fun", "4ismmfcftg3tn4d41mf.apps.userland.fun"]);

const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Most leads and entries one visitor can save, and most entries the whole
 * demo takes in any hour. Adding a lead is one entry; each stage change,
 * follow-up date, or note is one more. Keep perHour under 100, the most
 * entries one count can see.
 */
export const DEMO_LIMITS = { leads: 10, entries: 40, perHour: 60 };

/** Hours a demo entry is kept before it's removed. */
export const DEMO_KEEP_HOURS = 12;

/** Most expired rows one save removes on its way through. */
export const SWEEP_BATCH = 4;

const HOUR_MS = 3_600_000;

/**
 * Thrown when the demo refuses a change. server/index.js shows a friendly
 * page. `scope` is "visitor" (this visitor's limit), "everyone" (the hourly
 * limit), or "sample" (sample leads can't be deleted).
 */
export class DemoLimitError extends Error {
  code = "demo_limit";
  constructor(scope) {
    super(`Demo limit reached (${scope}).`);
    this.scope = scope;
  }
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
    received_at: minutesAgo(now, ago),
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

/** Apply this visitor's saved changes to a lead. */
function applyChanges(lead, changes) {
  const next = { ...lead };
  for (const change of [...changes].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (change.kind === "stage" && change.stage) next.stage = change.stage;
    if (change.kind === "follow_up") next.follow_up_on = change.body;
    next.updated_at = change.created_at;
  }
  return next;
}

const LEAD_FIELDS = ["name", "email", "phone", "project", "budget", "timeline", "details", "source"];
const startsLead = (entry) => entry.kind === "received" || entry.kind === "added";
const isDemoLeadId = (id) => id.startsWith("demo-");

/** A lead added in the demo, from the entry that holds its details. */
function leadFromEntry(entry) {
  let saved = {};
  try {
    saved = JSON.parse(entry.body);
  } catch {
    // Not a lead's details; show what the entry itself has.
  }
  const lead = { id: entry.lead_id, stage: "new", follow_up_on: "", received_at: entry.created_at, created_at: entry.created_at, updated_at: entry.created_at };
  for (const field of LEAD_FIELDS) lead[field] = typeof saved?.[field] === "string" ? saved[field] : "";
  if (!lead.name) lead.name = entry.lead_name;
  return lead;
}

/** History as the pages show it: a lead's details stay out of the feed. */
function forHistory(entry) {
  return startsLead(entry) ? { ...entry, body: "" } : entry;
}

/**
 * A store with the same methods as createStore() in leads.js, limited to the
 * sample leads plus this visitor's own rows. `key` is "" for visitors who
 * haven't saved anything yet; they can read but not write.
 */
function openStore(ctx, key, now = new Date()) {
  const leads = () => ctx.data.collection("leads");
  const activity = () => ctx.data.collection("activity");
  const cutoff = now.getTime() - DEMO_KEEP_HOURS * HOUR_MS;
  const isExpired = (row) => !row.demo_saved_at || Date.parse(row.demo_saved_at) <= cutoff;
  let own = null;

  /** This visitor's entries that haven't expired, newest first. Loaded once per request. */
  async function ownActivity() {
    if (!key) return [];
    own ??= activity()
      .list({ where: { demo_visitor: key }, limit: 100 })
      .then((result) => result.rows.filter((row) => !isExpired(row)).map(normalizeActivity).sort(byNewest));
    return await own;
  }

  async function allActivity() {
    return [...sampleActivity(now), ...(await ownActivity())].sort(byNewest);
  }

  async function allLeads() {
    const mine = await ownActivity();
    const added = mine.filter((entry) => startsLead(entry) && isDemoLeadId(entry.lead_id)).map(leadFromEntry);
    return [...sampleLeads(now), ...added]
      .map((lead) => applyChanges(lead, mine.filter((entry) => entry.lead_id === lead.id && !startsLead(entry))))
      .sort(byReceived);
  }

  /** The newest 100 entries across the demo, newest first. */
  async function newestEntries() {
    return await activity().list({ order_by: [{ field: "demo_saved_at", direction: "desc" }], limit: 100 });
  }

  /** How many of `rows` the demo saved in the last hour. */
  function countLastHour(rows) {
    return rows.filter((row) => !isExpired(row) && Date.parse(row.demo_saved_at) > now.getTime() - HOUR_MS).length;
  }

  /**
   * Remove up to SWEEP_BATCH expired rows, then return how many entries the
   * whole demo saved in the last hour. Rows without demo_saved_at come from an
   * older version of the demo, count as expired, and sort first when newest
   * first; those older versions also saved each lead in the leads
   * collection, so that row goes too. Until they're all gone, they take
   * places in the newest 100 and can hide recent entries from the count.
   */
  async function sweepAndCountLastHour() {
    const [oldest, newest] = await Promise.all([
      activity().list({ order_by: [{ field: "demo_saved_at", direction: "asc" }], limit: SWEEP_BATCH }),
      newestEntries()
    ]);
    const expired = new Map();
    for (const row of [...newest.rows, ...oldest.rows]) {
      if (expired.size < SWEEP_BATCH && isExpired(row)) expired.set(row.id, row);
    }
    await Promise.all(
      [...expired.values()].map(async (row) => {
        await activity().delete(row.id);
        if (!row.demo_saved_at && startsLead(row) && row.lead_id && !row.lead_id.startsWith("sample-") && !isDemoLeadId(row.lead_id)) {
          await leads().delete(row.lead_id);
        }
      })
    );
    return countLastHour(newest.rows);
  }

  /** Throw DemoLimitError unless this visitor, and the demo, can take `entries` more. */
  async function assertRoom({ lead = false, entries = 1 } = {}) {
    if (!key) throw new Error("Demo writes need a visitor key.");
    const mine = await ownActivity();
    if (lead && mine.filter((entry) => startsLead(entry) && isDemoLeadId(entry.lead_id)).length >= DEMO_LIMITS.leads) throw new DemoLimitError("visitor");
    if (mine.length + entries > DEMO_LIMITS.entries) throw new DemoLimitError("visitor");
    if ((await sweepAndCountLastHour()) + entries > DEMO_LIMITS.perHour) throw new DemoLimitError("everyone");
  }

  /**
   * Save this visitor's entries, then count the last hour again with them
   * included. Over DEMO_LIMITS.perHour, take them all back and refuse.
   */
  async function record(entries) {
    const saved = [];
    try {
      for (const entry of entries) {
        saved.push(await activity().create({ ...entry, demo_visitor: key, demo_saved_at: new Date().toISOString() }));
      }
      if (countLastHour((await newestEntries()).rows) > DEMO_LIMITS.perHour) throw new DemoLimitError("everyone");
    } catch (error) {
      await Promise.all(saved.map((row) => activity().delete(row.id).catch(() => {})));
      throw error;
    } finally {
      own = null;
    }
    return saved.map(normalizeActivity);
  }

  return {
    async listLeads({ stage = "" } = {}) {
      const all = await allLeads();
      return { leads: stage ? all.filter((lead) => lead.stage === stage) : all, cursor: "" };
    },

    async summarize(summaryNow) {
      const all = await allLeads();
      return summarizeLeads(
        STAGES.map(({ value }) => ({ stage: value, leads: all.filter((lead) => lead.stage === value), more: false })),
        summaryNow
      );
    },

    async getLead(id) {
      if (!id.startsWith("sample-") && !(key && isDemoLeadId(id))) return null;
      // Only this visitor's rows are loaded, so another visitor's lead id finds nothing.
      return (await allLeads()).find((lead) => lead.id === id) ?? null;
    },

    async createLead(values, { via }) {
      await assertRoom({ lead: true });
      const details = Object.fromEntries(LEAD_FIELDS.map((field) => [field, values[field] ?? ""]));
      const [entry] = await record([{ lead_id: `demo-${newKey()}`, lead_name: values.name, kind: via === "public" ? "received" : "added", stage: "new", body: JSON.stringify(details) }]);
      return leadFromEntry(entry);
    },

    async updateLead(lead, values) {
      const stageChanged = values.stage !== lead.stage;
      const followChanged = values.follow_up_on !== lead.follow_up_on;
      if (!stageChanged && !followChanged) return lead;
      await assertRoom({ entries: (stageChanged ? 1 : 0) + (followChanged ? 1 : 0) });
      await record([
        ...(stageChanged ? [{ lead_id: lead.id, lead_name: lead.name, kind: "stage", stage: values.stage, body: "" }] : []),
        ...(followChanged ? [{ lead_id: lead.id, lead_name: lead.name, kind: "follow_up", body: values.follow_up_on }] : [])
      ]);
      return { ...lead, ...values };
    },

    async addNote(lead, body) {
      await assertRoom();
      const [entry] = await record([{ lead_id: lead.id, lead_name: lead.name, kind: "note", body }]);
      return entry;
    },

    async recentActivity(limit) {
      return (await allActivity()).slice(0, limit).map(forHistory);
    },

    async leadHistory(leadId) {
      return { entries: (await allActivity()).filter((entry) => entry.lead_id === leadId).map(forHistory), more: false };
    },

    /** Visitors can delete leads they added. Sample leads stay for everyone. */
    async deleteLead(lead) {
      if (!isDemoLeadId(lead.id)) throw new DemoLimitError("sample");
      const rows = (await ownActivity()).filter((entry) => entry.lead_id === lead.id);
      // The entry holding the lead's details goes last, like the lead row in leads.js.
      const ordered = [...rows.filter((entry) => !startsLead(entry)), ...rows.filter(startsLead)];
      const batch = ordered.slice(0, DELETE_BATCH);
      await Promise.all(batch.map((entry) => activity().delete(entry.id)));
      own = null;
      return { done: batch.length === ordered.length };
    }
  };
}

export const demo = {
  /** Hours a demo entry is kept, for the demo notes on the pages. */
  keepHours: DEMO_KEEP_HOURS,
  /** True when this request is for the public demo (one of DEMO_HOSTS). */
  activeFor(url) {
    return DEMO_HOSTS.has(url.hostname);
  },
  /** The visitor key from ?demo= or a hidden form field, or "" when absent or malformed. */
  keyFrom(url, form = {}) {
    const value = String(form.demo || url.searchParams.get("demo") || "");
    return KEY_PATTERN.test(value) ? value : "";
  },
  newKey,
  openStore
};

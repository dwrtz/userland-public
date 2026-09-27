// Lead domain: the options people pick from, input validation, and the
// production store backed by Userland managed data (ctx.data).
//
// The option lists below must match the enum values declared in
// manifest.userland.json. Change both together.

export const STAGES = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "site_visit", label: "Site visit" },
  { value: "quoted", label: "Quoted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" }
];

export const PROJECTS = [
  { value: "kitchen", label: "Kitchen" },
  { value: "bathroom", label: "Bathroom" },
  { value: "basement", label: "Basement" },
  { value: "addition", label: "Addition" },
  { value: "exterior", label: "Deck, porch, or exterior" },
  { value: "repairs", label: "Repairs" },
  { value: "other", label: "Something else" }
];

export const BUDGETS = [
  { value: "under_15k", label: "Under $15k" },
  { value: "15k_40k", label: "$15k to $40k" },
  { value: "40k_80k", label: "$40k to $80k" },
  { value: "over_80k", label: "Over $80k" },
  { value: "not_sure", label: "Not sure yet" }
];

export const TIMELINES = [
  { value: "asap", label: "As soon as possible" },
  { value: "1_3_months", label: "In 1 to 3 months" },
  { value: "3_6_months", label: "In 3 to 6 months" },
  { value: "planning", label: "Just planning" }
];

export const SOURCES = [
  { value: "website", label: "Website form" },
  { value: "phone", label: "Phone call" },
  { value: "referral", label: "Referral" },
  { value: "repeat_client", label: "Repeat client" },
  { value: "other", label: "Other" }
];

/** Stages that still need work. Won and lost leads are closed. */
export const OPEN_STAGES = new Set(["new", "contacted", "site_visit", "quoted"]);

export const LIMITS = {
  name: 80,
  email: 120,
  phone: 30,
  details: 1000,
  note: 1000
};

export function labelFor(options, value) {
  return options.find((option) => option.value === value)?.label ?? "";
}

function isOption(options, value) {
  return options.some((option) => option.value === value);
}

// ---------------------------------------------------------------------------
// Validation. Every value that reaches ctx.data goes through these helpers:
// trimmed, length-limited, and checked against the allowed options.
// ---------------------------------------------------------------------------

/** Trim, drop control characters, and collapse runs of spaces on one line. */
export function cleanLine(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Like cleanLine, but keeps line breaks for multi-line text. */
export function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A plain address: letters, digits, and . _ + ' - ! $ * / = ^ ` { | } ~ before
// the @, then a domain with at least one dot. No ? & % or #, so an address can't
// carry extra parts (subject, bcc) into the owner's "mailto:" link.
const EMAIL_PATTERN = /^[A-Za-z0-9.!$'*+/=^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const PHONE_PATTERN = /^[0-9+().\-\s]{7,}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Validate a lead from the public estimate form (who = "public") or from the
 * owner's "Add a lead" form (who = "owner"). Returns { values, errors }.
 * errors maps field name to a message a person can act on.
 */
export function validateLead(form, who) {
  const values = {
    name: cleanLine(form.name),
    email: cleanLine(form.email).toLowerCase(),
    phone: cleanLine(form.phone),
    project: cleanLine(form.project),
    budget: cleanLine(form.budget),
    timeline: cleanLine(form.timeline),
    details: cleanText(form.details),
    source: who === "public" ? "website" : cleanLine(form.source)
  };
  const errors = {};

  if (!values.name) errors.name = "Enter a name.";
  else if (values.name.length > LIMITS.name) errors.name = `Keep the name under ${LIMITS.name} characters.`;

  if (values.email.length > LIMITS.email || (values.email && !EMAIL_PATTERN.test(values.email))) {
    errors.email = "Enter an email address like name@example.com.";
  } else if (!values.email && who === "public") {
    errors.email = "Enter your email so we can reply.";
  }

  if (values.phone.length > LIMITS.phone || (values.phone && !PHONE_PATTERN.test(values.phone))) {
    errors.phone = "Enter a phone number using digits, spaces, or dashes.";
  }
  if (who === "owner" && !values.email && !values.phone && !errors.email && !errors.phone) {
    errors.email = "Add an email or a phone number so you can follow up.";
  }

  if (!isOption(PROJECTS, values.project)) errors.project = "Choose the kind of project.";
  if (!isOption(BUDGETS, values.budget)) errors.budget = "Choose a budget range.";
  if (who === "public" && !isOption(TIMELINES, values.timeline)) errors.timeline = "Choose when you'd like to start.";
  if (who === "owner" && values.timeline && !isOption(TIMELINES, values.timeline)) errors.timeline = "Choose when they'd like to start.";
  if (who === "owner" && !isOption(SOURCES, values.source)) errors.source = "Choose where the lead came from.";

  if (values.details.length > LIMITS.details) errors.details = `Keep this under ${LIMITS.details} characters.`;
  if (who === "public" && values.details.length < 10) errors.details = "Tell us a little about the project.";

  return { values, errors };
}

/** Validate the owner's "Update lead" form: a stage and an optional follow-up date. */
export function validateUpdate(form) {
  const values = {
    stage: cleanLine(form.stage),
    follow_up_on: cleanLine(form.follow_up_on)
  };
  const errors = {};
  if (!isOption(STAGES, values.stage)) errors.stage = "Choose a stage.";
  if (values.follow_up_on && !isValidDate(values.follow_up_on)) errors.follow_up_on = "Pick a date for the follow-up, or leave it blank.";
  return { values, errors };
}

export function validateNote(form) {
  const body = cleanText(form.body);
  const errors = {};
  if (!body) errors.body = "Write a note before saving.";
  else if (body.length > LIMITS.note) errors.body = `Keep notes under ${LIMITS.note} characters.`;
  return { values: { body }, errors };
}


// ---------------------------------------------------------------------------
// Production store. Two managed data collections declared in the manifest:
//   leads     one row per lead, holding the current stage and follow-up date.
//             Indexes: by_stage (stage + received_at) for the board's tabs and
//             pages, and by_request_key (unique) for the per-email limit on the
//             public form.
//   activity  an append-only history: received, added, stage, follow_up, note.
//             Index: by_lead (lead_id) for a lead's history.
// Both collections are server_only, so every read and write goes through the
// routes in server/index.js.
//
// Every method makes a small, fixed number of ctx.data calls, because each
// call counts toward the plan's subrequests per request (25 on Free). Nothing
// pages through a whole collection.
// ---------------------------------------------------------------------------

/** Leads per page on the board. Older leads are one "Older leads" click away. */
export const PAGE_SIZE = 50;

/** Leads counted per stage for the board's tabs and stats. More show as "100+". */
export const COUNT_LIMIT = 100;

/** History entries loaded on a lead page: up to 3 pages of 100, newest first. */
const HISTORY_PAGES = 3;

/**
 * History entries removed per request when the owner deletes a lead. A lead
 * with a longer history needs another press of Delete; the lead itself goes
 * last, so it never disappears while history still points to it.
 */
export const DELETE_BATCH = 15;

/**
 * Limits on the public request form, so a script can't use up the app's data
 * rows (Free includes 1,000, and each request uses 2):
 * - perEmailPerDay: requests one email address can send in a UTC day. Enforced
 *   with the unique by_request_key index, so it holds even when requests arrive
 *   at the same moment.
 * - perHour, perDay: requests the form takes across everyone. Checked with one
 *   query before saving, so a burst of simultaneous requests can pass it by
 *   a few. Leads the owner adds count toward these but are never refused.
 */
export const REQUEST_LIMITS = { perEmailPerDay: 3, perHour: 20, perDay: 60 };

/** Thrown when the public form refuses a request. `scope` is "email" or "busy". */
export class RequestLimitError extends Error {
  code = "request_limit";
  constructor(scope) {
    super(`Request limit reached (${scope}).`);
    this.scope = scope;
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NEWEST_FIRST = [{ field: "received_at", direction: "desc" }];

export function normalizeLead(row) {
  return {
    id: row.id,
    name: row.name ?? "",
    email: row.email ?? "",
    phone: row.phone ?? "",
    project: row.project ?? "other",
    budget: row.budget ?? "not_sure",
    timeline: row.timeline ?? "",
    details: row.details ?? "",
    stage: row.stage ?? "new",
    source: row.source ?? "other",
    follow_up_on: row.follow_up_on ?? "",
    received_at: row.received_at || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function normalizeActivity(row) {
  return {
    id: row.id,
    lead_id: row.lead_id ?? "",
    lead_name: row.lead_name ?? "",
    kind: row.kind ?? "note",
    stage: row.stage ?? "",
    body: row.body ?? "",
    created_at: row.created_at
  };
}

export function byNewest(left, right) {
  return String(right.created_at).localeCompare(String(left.created_at));
}

export function byReceived(left, right) {
  return String(right.received_at).localeCompare(String(left.received_at));
}

export function today(now) {
  return now.toISOString().slice(0, 10);
}

/** An open lead with a follow-up date of today or earlier. */
export function isDue(lead, now) {
  return OPEN_STAGES.has(lead.stage) && Boolean(lead.follow_up_on) && lead.follow_up_on <= today(now);
}

/**
 * Board numbers from the leads loaded for each stage. `groups` is
 * [{ stage, leads, more }], where `more` means the stage has leads beyond the
 * ones loaded. Every number is { count, more }; views show "100+" when `more`.
 */
export function summarizeLeads(groups, now) {
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const sum = (list) => ({ count: list.reduce((total, group) => total + group.leads.length, 0), more: list.some((group) => group.more) });
  const open = groups.filter((group) => OPEN_STAGES.has(group.stage));
  const dueCount = open.reduce((total, group) => total + group.leads.filter((lead) => isDue(lead, now)).length, 0);
  const weekCount = groups.reduce((total, group) => total + group.leads.filter((lead) => Date.parse(lead.received_at) >= weekAgo).length, 0);
  // Leads beyond the loaded ones are older than the last loaded one, so they
  // can only add to "this week" when that last one is from this week.
  const weekMore = groups.some((group) => group.more && group.leads.length > 0 && Date.parse(group.leads.at(-1).received_at) >= weekAgo);
  return {
    counts: Object.fromEntries(groups.map((group) => [group.stage, { count: group.leads.length, more: group.more }])),
    total: sum(groups),
    open: sum(open),
    due: { count: dueCount, more: open.some((group) => group.more) },
    thisWeek: { count: weekCount, more: weekMore }
  };
}

/** A per-day key for one email address, without storing the address again. */
async function requestKeyBase(email, now) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const hex = [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${today(now)}:${hex}`;
}

function isUniqueConflict(error) {
  return error?.code === "unique_conflict";
}

export function createStore(ctx) {
  const leads = () => ctx.data.collection("leads");
  const activity = () => ctx.data.collection("activity");

  /** Refuse public requests while the form is over REQUEST_LIMITS.perHour or perDay. */
  async function assertFormOpen(now) {
    const { rows } = await leads().list({ order_by: NEWEST_FIRST, limit: REQUEST_LIMITS.perDay });
    const since = (ms) => rows.filter((row) => Date.parse(row.received_at || row.created_at) > now.getTime() - ms).length;
    if (since(HOUR_MS) >= REQUEST_LIMITS.perHour || since(DAY_MS) >= REQUEST_LIMITS.perDay) {
      throw new RequestLimitError("busy");
    }
  }

  /**
   * Save a lead and its first history entry. ctx.data.transaction groups the
   * two writes but does not undo the first if the second fails, so a lead can
   * exist without its "received" entry; the pages handle that.
   */
  async function saveLead(values, { via, receivedAt, requestKey }) {
    return await ctx.data.transaction(async (tx) => {
      const lead = await tx.collection("leads").create({
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
        received_at: receivedAt,
        request_key: requestKey
      });
      await tx.collection("activity").create({
        lead_id: lead.id,
        lead_name: values.name,
        kind: via === "public" ? "received" : "added",
        stage: "new",
        body: ""
      });
      return normalizeLead(lead);
    });
  }

  return {
    /** One page of leads, newest first, optionally for one stage. */
    async listLeads({ stage = "", cursor = "" } = {}) {
      const page = await leads().list({
        ...(stage ? { where: { stage } } : {}),
        order_by: NEWEST_FIRST,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {})
      });
      return { leads: page.rows.map(normalizeLead), cursor: page.cursor ?? "" };
    },

    /** Counts for the board's tabs and stats: one query per stage. */
    async summarize(now) {
      const pages = await Promise.all(STAGES.map(({ value }) => leads().list({ where: { stage: value }, order_by: NEWEST_FIRST, limit: COUNT_LIMIT })));
      return summarizeLeads(
        STAGES.map(({ value }, index) => ({ stage: value, leads: pages[index].rows.map(normalizeLead), more: Boolean(pages[index].cursor) })),
        now
      );
    },

    async getLead(id) {
      const row = await leads().get(id);
      return row ? normalizeLead(row) : null;
    },

    /**
     * Create a lead. Public requests pass REQUEST_LIMITS first: each email
     * address gets perEmailPerDay slots a day in the unique request_key index,
     * and a request takes the first free slot. When every slot is taken the
     * platform refuses the write, so two requests can never share one.
     */
    async createLead(values, { via, now = new Date() }) {
      const receivedAt = now.toISOString();
      if (via !== "public") return await saveLead(values, { via, receivedAt });

      await assertFormOpen(now);
      const base = await requestKeyBase(values.email, now);
      for (let slot = 0; slot < REQUEST_LIMITS.perEmailPerDay; slot += 1) {
        try {
          return await saveLead(values, { via, receivedAt, requestKey: `${base}:${slot}` });
        } catch (error) {
          if (!isUniqueConflict(error)) throw error;
        }
      }
      throw new RequestLimitError("email");
    },

    /** Change the stage and/or follow-up date, recording each change. */
    async updateLead(lead, values) {
      return await ctx.data.transaction(async (tx) => {
        const patch = {};
        if (values.stage !== lead.stage) patch.stage = values.stage;
        if (values.follow_up_on !== lead.follow_up_on) patch.follow_up_on = values.follow_up_on;
        if (Object.keys(patch).length === 0) return lead;

        const updated = await tx.collection("leads").update(lead.id, patch);
        if (patch.stage) {
          await tx.collection("activity").create({ lead_id: lead.id, lead_name: lead.name, kind: "stage", stage: patch.stage, body: "" });
        }
        if (patch.follow_up_on !== undefined) {
          await tx.collection("activity").create({ lead_id: lead.id, lead_name: lead.name, kind: "follow_up", body: patch.follow_up_on });
        }
        return normalizeLead(updated);
      });
    },

    async addNote(lead, body) {
      const row = await activity().create({ lead_id: lead.id, lead_name: lead.name, kind: "note", body });
      return normalizeActivity(row);
    },

    /**
     * The newest history entries across all leads, for the board's feed.
     * Without order_by, rows come back most recently updated first, and
     * history rows are never updated, so this is the newest `limit` entries.
     */
    async recentActivity(limit) {
      const result = await activity().list({ limit });
      return result.rows.map(normalizeActivity).sort(byNewest);
    },

    /** One lead's history, newest first. `more` is true when older entries weren't loaded. */
    async leadHistory(leadId) {
      const rows = [];
      let cursor;
      for (let page = 0; page < HISTORY_PAGES; page += 1) {
        const result = await activity().list({ where: { lead_id: leadId }, limit: 100, ...(cursor ? { cursor } : {}) });
        rows.push(...result.rows);
        cursor = result.cursor;
        if (!cursor) break;
      }
      return { entries: rows.map(normalizeActivity).sort(byNewest), more: Boolean(cursor) };
    },

    /**
     * Delete a lead and its history, DELETE_BATCH history entries at a time.
     * Returns { done: false } when history is left and the lead is kept, so
     * the owner can press Delete again.
     */
    async deleteLead(lead) {
      const page = await activity().list({ where: { lead_id: lead.id }, limit: DELETE_BATCH });
      await Promise.all(page.rows.map((row) => activity().delete(row.id)));
      if (page.cursor) return { done: false };
      await leads().delete(lead.id);
      return { done: true };
    }
  };
}

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
//             `via` is "form" for requests from the public form and "owner"
//             for leads the owner adds. Indexes: by_stage (stage +
//             received_at) for the board's tabs and pages, and by_via (via +
//             received_at) for the public form's limits. The demo_visitor
//             field is unused; earlier versions of the demo used it, and
//             Userland refuses a release that removes a field once published.
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
 * - perEmailPerDay: requests one email address can send in 24 hours.
 * - perHour, perDay: requests the form takes from everyone in the last hour
 *   and the last 24 hours.
 * Only requests from the form count (via "form"). Leads the owner adds never
 * count toward these and are never refused.
 *
 * How they hold when requests arrive at the same moment: each request counts
 * the recent form leads, saves its lead, then counts again with its own lead
 * included and takes the lead back if that count is over a limit. Whatever
 * order simultaneous requests run in, the last one to count sees every lead
 * that stays, so the leads that stay never pass a limit. The cost is that a
 * few requests arriving together right at a limit can all be turned away.
 * Keep perDay under FORM_WINDOW, the most leads one count can see.
 */
export const REQUEST_LIMITS = { perEmailPerDay: 3, perHour: 20, perDay: 60 };

/** Newest form leads loaded for each count. Must stay above REQUEST_LIMITS.perDay. */
const FORM_WINDOW = 100;

/**
 * Leads saved by an earlier version of this app have no received_at, and sort
 * ahead of every dated lead. Each board visit fills it in (from created_at)
 * for up to this many of them.
 */
export const REPAIR_BATCH = 12;

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

/**
 * Which REQUEST_LIMITS a count is over once `adding` more leads arrive:
 * "email", "busy", or "" when there's room.
 */
function overLimit(counts, adding) {
  if (counts.email + adding > REQUEST_LIMITS.perEmailPerDay) return "email";
  if (counts.hour + adding > REQUEST_LIMITS.perHour || counts.day + adding > REQUEST_LIMITS.perDay) return "busy";
  return "";
}

export function createStore(ctx) {
  const leads = () => ctx.data.collection("leads");
  const activity = () => ctx.data.collection("activity");

  /**
   * Form leads received in the last hour and the last 24 hours, and how many
   * of those came from `email`. One query on the by_via index.
   */
  async function formCounts(email, now) {
    const { rows } = await leads().list({ where: { via: "form" }, order_by: NEWEST_FIRST, limit: FORM_WINDOW });
    const after = (ms) => rows.filter((row) => Date.parse(row.received_at) > now.getTime() - ms);
    const day = after(DAY_MS);
    return { hour: after(HOUR_MS).length, day: day.length, email: day.filter((row) => row.email === email).length };
  }

  function leadRow(values, via, receivedAt) {
    return {
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
      via
    };
  }

  /** The first history entry for a new lead. */
  function firstEntry(lead, via) {
    return { lead_id: lead.id, lead_name: lead.name, kind: via === "form" ? "received" : "added", stage: "new", body: "" };
  }

  /**
   * Fill in received_at on leads from an earlier version of this app (see
   * REPAIR_BATCH), so they sort by age with the rest.
   */
  async function repairOlderLeads(rows) {
    const older = rows.filter((row) => !row.received_at && row.created_at).slice(0, REPAIR_BATCH);
    await Promise.all(older.map((row) => leads().update(row.id, { received_at: row.created_at })));
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

    /**
     * Counts for the board's tabs and stats: one query per stage. Also fills
     * in received_at on a few older leads (repairOlderLeads).
     */
    async summarize(now) {
      const pages = await Promise.all(STAGES.map(({ value }) => leads().list({ where: { stage: value }, order_by: NEWEST_FIRST, limit: COUNT_LIMIT })));
      await repairOlderLeads(pages.flatMap((page) => page.rows));
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
     * Create a lead and its first history entry. ctx.data.transaction groups
     * the two writes but does not undo the first if the second fails, so a
     * lead can exist without its first entry; the pages handle that.
     *
     * Requests from the public form (via "public") pass REQUEST_LIMITS: count,
     * save, count again, and take the lead back if the second count is over.
     * The history entry is saved only once the lead has passed.
     */
    async createLead(values, { via, now = new Date() }) {
      const receivedAt = now.toISOString();
      if (via !== "public") {
        return await ctx.data.transaction(async (tx) => {
          const lead = await tx.collection("leads").create(leadRow(values, "owner", receivedAt));
          await tx.collection("activity").create(firstEntry(lead, "owner"));
          return normalizeLead(lead);
        });
      }

      const before = overLimit(await formCounts(values.email, now), 1);
      if (before) throw new RequestLimitError(before);
      const lead = await leads().create(leadRow(values, "form", receivedAt));
      let after;
      try {
        after = overLimit(await formCounts(values.email, now), 0);
      } catch (error) {
        await leads().delete(lead.id).catch(() => {});
        throw error;
      }
      if (after) {
        await leads().delete(lead.id);
        throw new RequestLimitError(after);
      }
      await activity().create(firstEntry(lead, "form"));
      return normalizeLead(lead);
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

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

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
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
//   leads     one row per lead, holding the current stage and follow-up date
//   activity  an append-only history: received, added, stage, follow_up, note
// Both collections are server_only, so every read and write goes through the
// routes in server/index.js.
// ---------------------------------------------------------------------------

/** Upper bound on leads loaded for the board: five pages of 100 rows. */
const MAX_LEAD_PAGES = 5;

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

export function createStore(ctx) {
  const leads = () => ctx.data.collection("leads");
  const activity = () => ctx.data.collection("activity");

  return {
    /** Every lead, newest first. A small shop's list fits in a few pages. */
    async listLeads() {
      const rows = [];
      let cursor;
      for (let page = 0; page < MAX_LEAD_PAGES; page += 1) {
        const result = await leads().list({ limit: 100, ...(cursor ? { cursor } : {}) });
        rows.push(...result.rows);
        cursor = result.cursor;
        if (!cursor) break;
      }
      return rows.map(normalizeLead).sort(byNewest);
    },

    async getLead(id) {
      const row = await leads().get(id);
      return row ? normalizeLead(row) : null;
    },

    /** Create a lead and its first activity entry together. */
    async createLead(values, { via }) {
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
          follow_up_on: ""
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
     * Recent activity across all leads, or the full history of one lead.
     * Rows come back most recently updated first, and activity rows are never
     * updated, so `limit` keeps the newest entries.
     */
    async listActivity({ leadId, limit = 100 } = {}) {
      const result = await activity().list({
        ...(leadId ? { where: { lead_id: leadId } } : {}),
        limit
      });
      return result.rows.map(normalizeActivity).sort(byNewest);
    }
  };
}

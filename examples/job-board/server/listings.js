// Listing rules and storage for the job board.
//
// Everything about what a listing is lives here: the categories and job types
// the board offers, the length limits for each field, and the store that reads
// and writes the `listings` collection declared in manifest.userland.json.

export const CATEGORIES = [
  { id: "field-crops", label: "Vegetables & field crops" },
  { id: "livestock", label: "Livestock & grazing" },
  { id: "orchards", label: "Orchards & vineyards" },
  { id: "markets", label: "Markets & CSA" },
  { id: "education", label: "Teaching & outreach" },
  { id: "management", label: "Farm management" }
];

export const JOB_TYPES = [
  { id: "full-time", label: "Full-time" },
  { id: "seasonal", label: "Seasonal" },
  { id: "part-time", label: "Part-time" },
  { id: "apprenticeship", label: "Apprenticeship" }
];

// Stored status value -> the words the owner sees.
export const STATUS_LABELS = {
  pending: "Waiting for review",
  approved: "Live",
  rejected: "Declined",
  closed: "Closed"
};

// Public form fields with their limits. `min` of 0 means optional.
export const FIELD_LIMITS = {
  title: { min: 3, max: 90 },
  employer: { min: 2, max: 80 },
  location: { min: 2, max: 80 },
  pay: { min: 0, max: 60 },
  summary: { min: 10, max: 160 },
  description: { min: 40, max: 4000 },
  apply_link: { min: 3, max: 300 },
  contact_name: { min: 2, max: 80 },
  contact_email: { min: 3, max: 254 },
  owner_note: { min: 0, max: 500 }
};

// Fields that never leave the server on public pages.
export const PRIVATE_FIELDS = ["contact_name", "contact_email", "owner_note", "history"];

const HISTORY_LIMIT = 20;
// Letters, digits, and . _ + ' - before the @; a plain domain after it. Characters
// such as ? & = % # are refused so an address can't smuggle extra recipients
// (like ?bcc=...) into the "Email the employer" link.
const EMAIL_PATTERN = /^[a-z0-9._+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/iu;

// Spam limits for the public "Post a job" form. The board never holds more than
// MAX_PENDING listings waiting for review, and one contact email can have at most
// MAX_PENDING_PER_EMAIL of them. Both are checked before saving and the queue
// size again right after (see create() below). Raise them if your board is busy,
// keeping MAX_PENDING at 100 or less so one data call can read the whole queue.
export const MAX_PENDING = 100;
export const MAX_PENDING_PER_EMAIL = 3;

// Pages read at most this many rows of live jobs (100 per data call). 1,000 is
// every row the Free plan allows, so the board sees every live job there.
export const MAX_LIVE_ROWS = 1000;

// "Delete all declined" removes this many listings per press, which keeps one
// request well under the plan's limit on data calls per request (Free: 25).
export const BULK_DELETE_MAX = 15;

/** Thrown when the review queue is full or one email has sent too many listings. */
export class SubmissionLimitError extends Error {
  name = "SubmissionLimitError";
  constructor(reason) {
    super(reason === "email" ? "Too many listings waiting from this email." : "The review queue is full.");
    this.reason = reason;
  }
}

export function categoryLabel(id) {
  return CATEGORIES.find((category) => category.id === id)?.label ?? "Other";
}

export function jobTypeLabel(id) {
  return JOB_TYPES.find((type) => type.id === id)?.label ?? "";
}

// Trim, drop control characters, and collapse runs of blank lines.
function cleanText(value, { multiline = false } = {}) {
  let text = String(value ?? "").replace(/\r\n?/gu, "\n");
  text = multiline ? text.replace(/[^\S\n]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n") : text.replace(/\s+/gu, " ");
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, "").trim();
}

export function isEmail(value) {
  return EMAIL_PATTERN.test(value);
}

// An apply link is either a web address or an email address.
export function applyHref(link) {
  if (isEmail(link)) return `mailto:${link}`;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Validate a listing form. Returns { values, errors } where `errors` maps a
 * field name to a message written for the person filling in the form.
 * With `owner: true`, the owner-only fields (featured, private note) are read too.
 */
export function validateListing(input, { owner = false } = {}) {
  const values = {};
  const errors = {};

  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    if (field === "owner_note" && !owner) continue;
    const value = cleanText(input[field], { multiline: field === "description" || field === "owner_note" });
    values[field] = value;
    if (limit.min > 0 && value.length === 0) {
      errors[field] = "Please fill this in.";
    } else if (value.length > 0 && value.length < limit.min) {
      errors[field] = `Please use at least ${limit.min} characters.`;
    } else if (value.length > limit.max) {
      errors[field] = `Please keep this under ${limit.max} characters.`;
    }
  }

  values.category = cleanText(input.category);
  if (!CATEGORIES.some((category) => category.id === values.category)) {
    errors.category = "Please choose a category.";
  }
  values.job_type = cleanText(input.job_type);
  if (!JOB_TYPES.some((type) => type.id === values.job_type)) {
    errors.job_type = "Please choose a job type.";
  }
  if (!errors.contact_email && !isEmail(values.contact_email)) {
    errors.contact_email = "Please enter an email address like name@yourfarm.com.";
  }
  if (!errors.apply_link && !applyHref(values.apply_link)) {
    errors.apply_link = "Please enter a web address starting with https:// or an email address.";
  }
  if (owner) {
    values.featured = input.featured === "on" || input.featured === true;
  }

  return { values, errors };
}

/** Append one entry to a listing's history, keeping the newest entries. */
export function withHistory(listing, action, at = new Date().toISOString()) {
  const history = Array.isArray(listing?.history) ? listing.history : [];
  return [...history, { at, action }].slice(-HISTORY_LIMIT);
}

/** The patch that moves a listing to a new status. */
export function statusPatch(listing, status, at = new Date().toISOString()) {
  const patch = { status, history: withHistory(listing, status, at) };
  if (status === "approved" && !listing.published_at) {
    patch.published_at = at;
  }
  return patch;
}

/** Copy the declared fields off a data row into a plain listing object. */
export function toListing(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? "",
    employer: row.employer ?? "",
    location: row.location ?? "",
    category: row.category ?? "",
    job_type: row.job_type ?? "",
    pay: row.pay ?? "",
    summary: row.summary ?? "",
    description: row.description ?? "",
    apply_link: row.apply_link ?? "",
    contact_name: row.contact_name ?? "",
    contact_email: row.contact_email ?? "",
    status: row.status ?? "pending",
    featured: row.featured === true,
    owner_note: row.owner_note ?? "",
    history: Array.isArray(row.history) ? row.history : [],
    submitted_at: row.submitted_at ?? row.created_at ?? "",
    published_at: row.published_at ?? ""
  };
}

/** Public pages get a copy without contact details, notes, or history. */
export function publicListing(listing) {
  const copy = { ...listing };
  for (const field of PRIVATE_FIELDS) delete copy[field];
  return copy;
}

/**
 * The store the routes use. It wraps the `listings` collection with the few
 * operations a job board needs. server/demo.js provides the same shape for
 * the public demo.
 *
 * Reads use the two indexes in the manifest: by_status (status, published_at)
 * for the public board and by_submitted (status, submitted_at) for the owner's
 * lists. Lists are read page by page with the returned cursor, never cut off
 * silently at the first page.
 */
export function listingStore(ctx) {
  const listings = ctx.data.collection("listings");
  return {
    /**
     * Every live job, newest first. Reads up to `maxRows` (default
     * MAX_LIVE_ROWS); `complete` is false when more live jobs exist than that.
     */
    async listLive({ maxRows = MAX_LIVE_ROWS } = {}) {
      const jobs = [];
      let cursor;
      do {
        const page = await listings.list({
          where: { status: "approved" },
          order_by: [{ field: "published_at", direction: "desc" }],
          limit: Math.min(100, maxRows - jobs.length),
          ...(cursor ? { cursor } : {})
        });
        jobs.push(...page.rows.map(toListing));
        cursor = page.cursor;
      } while (cursor && jobs.length < maxRows);
      return { jobs, complete: !cursor };
    },
    /**
     * One page of listings with a status (or every status when `status` is
     * null), newest submission first. Pass the returned `cursor` back for the
     * next page; no cursor means this was the last page.
     */
    async listByStatus(status, { cursor = "", limit = 50 } = {}) {
      const page = await listings.list({
        ...(status ? { where: { status } } : {}),
        order_by: [{ field: "submitted_at", direction: "desc" }],
        limit,
        ...(cursor ? { cursor } : {})
      });
      return { jobs: page.rows.map(toListing), cursor: page.cursor ?? "" };
    },
    /**
     * How many listings have each status (counted up to 100; `more` is true
     * past that), plus the most recently changed listings for the activity panel.
     */
    async summary() {
      const statuses = Object.keys(STATUS_LABELS);
      const pages = await Promise.all(statuses.map((status) => listings.list({ where: { status }, limit: 100 })));
      const counts = {};
      const recent = [];
      statuses.forEach((status, index) => {
        counts[status] = { count: pages[index].rows.length, more: Boolean(pages[index].cursor) };
        recent.push(...pages[index].rows.map(toListing));
      });
      return { counts, recent };
    },
    async get(id) {
      return toListing(await listings.get(id));
    },
    async create(values) {
      const queue = await listings.list({ where: { status: "pending" }, limit: MAX_PENDING });
      if (queue.rows.length >= MAX_PENDING) throw new SubmissionLimitError("queue");
      const email = values.contact_email.toLowerCase();
      const fromEmail = queue.rows.filter((row) => String(row.contact_email ?? "").toLowerCase() === email).length;
      if (fromEmail >= MAX_PENDING_PER_EMAIL) throw new SubmissionLimitError("email");

      const now = new Date().toISOString();
      const row = await listings.create({
        ...values,
        status: "pending",
        featured: false,
        owner_note: "",
        history: withHistory(null, "submitted", now),
        submitted_at: now
      });

      // Posts that arrive at the same moment can all pass the check above. Look
      // again now that this one is saved: if it isn't among the MAX_PENDING
      // oldest waiting listings, take it back out.
      const first = await listings.list({
        where: { status: "pending" },
        order_by: [{ field: "submitted_at", direction: "asc" }],
        limit: MAX_PENDING
      });
      if (first.cursor && !first.rows.some((item) => item.id === row.id)) {
        await listings.delete(row.id);
        throw new SubmissionLimitError("queue");
      }
      return toListing(row);
    },
    async update(id, patch) {
      return toListing(await listings.update(id, patch));
    },
    async delete(id) {
      await listings.delete(id);
    },
    /** Delete up to BULK_DELETE_MAX declined listings. Returns { deleted, more }. */
    async deleteDeclined() {
      const page = await listings.list({ where: { status: "rejected" }, limit: BULK_DELETE_MAX });
      for (const row of page.rows) await listings.delete(row.id);
      return { deleted: page.rows.length, more: Boolean(page.cursor) };
    }
  };
}

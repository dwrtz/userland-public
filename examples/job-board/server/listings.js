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
// MAX_PENDING_PER_EMAIL of them. Both are checked before saving and again right
// after (see create() below), so posts that arrive at the same moment can't push
// past them. Raise them if your board is busy, keeping MAX_PENDING at 100 or less
// so one data call can read the whole queue.
export const MAX_PENDING = 100;
export const MAX_PENDING_PER_EMAIL = 3;

// How many rows one data call returns at most (the platform's `list` limit).
// The board and the owner lists show this many listings per page.
export const PAGE_ROWS = 100;

// "Delete all declined" removes this many listings per press: 1 list call plus
// up to 15 deletes, well under Free's 25 subrequests per request.
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
 * Page views stay cheap on purpose. Today every `list` call reads the whole
 * collection before it filters and sorts, and Free gives each request 10 ms of
 * CPU, so a page makes at most two `list` calls however many listings are
 * saved: the board makes one, the owner page two. Long lists are read one page
 * of up to PAGE_ROWS at a time through the returned cursor ("Older jobs",
 * "Show more"), never cut off silently.
 *
 * Reads use the two indexes in the manifest: by_status (status, category,
 * job_type, published_at) for the public board and its filters, and
 * by_submitted (status, submitted_at) for the owner's lists.
 */
export function listingStore(ctx) {
  const listings = ctx.data.collection("listings");
  return {
    /**
     * One page of live jobs, newest first, optionally only one category and/or
     * job type. Pass the returned `cursor` back for the next page; an empty
     * cursor means this was the last page. One data call.
     */
    async listLive({ category = "", type = "", cursor = "", limit = PAGE_ROWS } = {}) {
      const page = await listings.list({
        where: { status: "approved", ...(category ? { category } : {}), ...(type ? { job_type: type } : {}) },
        order_by: [{ field: "published_at", direction: "desc" }],
        limit,
        ...(cursor ? { cursor } : {})
      });
      return { jobs: page.rows.map(toListing), cursor: page.cursor ?? "" };
    },
    /**
     * One page of listings with a status (or every status when `status` is
     * null), newest submission first. Pass the returned `cursor` back for the
     * next page; an empty cursor means this was the last page. One data call.
     */
    async listByStatus(status, { cursor = "", limit = PAGE_ROWS } = {}) {
      const page = await listings.list({
        ...(status ? { where: { status } } : {}),
        order_by: [{ field: "submitted_at", direction: "desc" }],
        limit,
        ...(cursor ? { cursor } : {})
      });
      return { jobs: page.rows.map(toListing), cursor: page.cursor ?? "" };
    },
    async get(id) {
      return toListing(await listings.get(id));
    },
    async create(values) {
      const queue = await listings.list({ where: { status: "pending" }, limit: MAX_PENDING });
      if (queue.rows.length >= MAX_PENDING) throw new SubmissionLimitError("queue");
      const email = values.contact_email.toLowerCase();
      const fromEmail = (row) => String(row.contact_email ?? "").toLowerCase() === email;
      if (queue.rows.filter(fromEmail).length >= MAX_PENDING_PER_EMAIL) throw new SubmissionLimitError("email");

      const now = new Date().toISOString();
      const row = await listings.create({
        ...values,
        status: "pending",
        featured: false,
        owner_note: "",
        history: withHistory(null, "submitted", now),
        submitted_at: now
      });

      // Posts that arrive at the same moment can all pass the checks above.
      // Look again now that this one is saved, oldest first: it must be among
      // the MAX_PENDING oldest waiting listings, and among the first
      // MAX_PENDING_PER_EMAIL from its email. If not, take it back out.
      const first = await listings.list({
        where: { status: "pending" },
        order_by: [{ field: "submitted_at", direction: "asc" }],
        limit: MAX_PENDING
      });
      let reason = "";
      if (first.cursor && !first.rows.some((item) => item.id === row.id)) {
        reason = "queue";
      } else {
        const sameEmail = first.rows.filter(fromEmail).sort(oldestFirst);
        const position = sameEmail.findIndex((item) => item.id === row.id);
        if (position >= MAX_PENDING_PER_EMAIL) reason = "email";
      }
      if (reason) {
        await listings.delete(row.id);
        throw new SubmissionLimitError(reason);
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

// Oldest submission first; the row id breaks ties so every request that looks
// at the same rows puts them in the same order.
function oldestFirst(a, b) {
  return String(a.submitted_at).localeCompare(String(b.submitted_at)) || String(a.id).localeCompare(String(b.id));
}

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
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/iu;

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
 */
export function listingStore(ctx) {
  const listings = ctx.data.collection("listings");
  return {
    async listLive() {
      const page = await listings.list({
        where: { status: "approved" },
        order_by: [{ field: "published_at", direction: "desc" }],
        limit: 100
      });
      return page.rows.map(toListing);
    },
    async listAll() {
      const page = await listings.list({
        order_by: [{ field: "submitted_at", direction: "desc" }],
        limit: 100
      });
      return page.rows.map(toListing);
    },
    async get(id) {
      return toListing(await listings.get(id));
    },
    async create(values) {
      const now = new Date().toISOString();
      const row = await listings.create({
        ...values,
        status: "pending",
        featured: false,
        owner_note: "",
        history: withHistory(null, "submitted", now),
        submitted_at: now
      });
      return toListing(row);
    },
    async update(id, patch) {
      return toListing(await listings.update(id, patch));
    }
  };
}

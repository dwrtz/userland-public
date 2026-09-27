// Waitlist rules: who is on the list, what they told us, and their place in line.
// Nothing in this file knows about HTML or requests, so it is easy to test and reuse.

export const COLLECTION = "signups";

// Each friend who joins with your link moves you up this many places.
export const REFERRAL_BOOST = 10;

export const STATUSES = ["waiting", "invited", "archived"];

// Optional questions shown after someone joins. Keys are stored; labels are shown.
export const QUESTIONS = {
  frequency: {
    label: "How often do you run?",
    options: {
      starting: "Just getting started",
      weekly: "Once or twice a week",
      "most-days": "Most days",
      training: "Training for a race"
    }
  },
  goal: {
    label: "What would get you out the door more?",
    options: {
      company: "People to run with",
      consistency: "A routine I'll stick to",
      routes: "New routes nearby",
      race: "A race to aim for"
    }
  }
};

export const LIMITS = {
  email: 254,
  name: 40,
  city: 60,
  source: 40,
  body: 4096
};

// The same characters a browser accepts in an email field (letters, digits, and
// .!#$%&'*+/=?^_`{|}~-), plus a real-looking domain. Markup characters such as < > " ( ) ; : [ ] \ are refused.
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-Z2-9]{6,10}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/u;

export class DuplicateSignupError extends Error {
  constructor() {
    super("This email is already on the list.");
    this.code = "duplicate_signup";
  }
}

// ---------------------------------------------------------------------------
// Input cleaning. Every value that reaches storage passes through one of these.
// ---------------------------------------------------------------------------

function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function normalizeCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : "";
}

// Validates the public join form. Returns { values, errors } where errors maps field -> message.
export function validateJoin(form) {
  const rawEmail = String(form.email ?? "").trim().toLowerCase();
  const values = {
    email: rawEmail.slice(0, LIMITS.email),
    name: clean(form.name, LIMITS.name),
    ref: normalizeCode(form.ref),
    source: clean(form.source, LIMITS.source).toLowerCase().replace(/[^a-z0-9_.-]/gu, "")
  };
  const errors = {};
  if (!rawEmail) {
    errors.email = "Enter your email so we can save your spot.";
  } else if (rawEmail.length > LIMITS.email || !EMAIL_PATTERN.test(rawEmail)) {
    errors.email = "That email doesn't look right. Check it and try again.";
  }
  if (String(form.name ?? "").trim().length > LIMITS.name) {
    errors.name = `Keep your name under ${LIMITS.name} characters.`;
  }
  return { values, errors };
}

// Validates the optional questions. Unknown answers are dropped rather than stored.
export function validateAnswers(form) {
  const frequency = String(form.frequency ?? "");
  const goal = String(form.goal ?? "");
  return {
    frequency: Object.hasOwn(QUESTIONS.frequency.options, frequency) ? frequency : "",
    goal: Object.hasOwn(QUESTIONS.goal.options, goal) ? goal : "",
    city: clean(form.city, LIMITS.city)
  };
}

// ---------------------------------------------------------------------------
// Random values: referral codes people share, and private links only they get.
// ---------------------------------------------------------------------------

export function newReferralCode(length = 7) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

// Compares secrets without stopping at the first different character.
export function safeEqual(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Referral credit.
// Nobody stores a running total. Each person's count is worked out from the
// friends who name their code in referred_by, so two friends joining at the
// same moment can never overwrite each other's credit. Archived friends don't
// count, which lets the owner undo credit from fake signups by archiving them.
// ---------------------------------------------------------------------------

export function withReferralCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.referred_by && row.status !== "archived") counts.set(row.referred_by, (counts.get(row.referred_by) ?? 0) + 1);
  }
  return rows.map((row) => ({ ...row, referrals: counts.get(row.referral_code) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Place in line.
// People keep the order they joined in, and each referral moves them up
// REFERRAL_BOOST places. Invited and archived people leave the line.
// ---------------------------------------------------------------------------

export function rankWaitlist(rows) {
  const joined = rows
    .filter((row) => row.status !== "archived")
    .sort((a, b) => a.joined_at.localeCompare(b.joined_at) || a.id.localeCompare(b.id));
  const joinNumber = new Map(joined.map((row, index) => [row.id, index + 1]));
  const score = (row) => {
    const referrals = row.referrals ?? 0;
    // The extra half place means someone who earned a move wins a tie.
    return joinNumber.get(row.id) - referrals * REFERRAL_BOOST - (referrals > 0 ? 0.5 : 0);
  };
  const waiting = joined
    .filter((row) => row.status === "waiting")
    .map((row) => ({ row, score: score(row) }))
    .sort((a, b) => a.score - b.score || joinNumber.get(a.row.id) - joinNumber.get(b.row.id));
  const positions = new Map(waiting.map((entry, index) => [entry.row.id, index + 1]));
  return { positions, waitingCount: waiting.length };
}

// ---------------------------------------------------------------------------
// Owner view helpers: filters, summary numbers, recent activity, CSV export.
// ---------------------------------------------------------------------------

export const PAGE_SIZE = 50;
export const SORTS = { line: "Place in line", newest: "Newest first", referrals: "Most referrals" };

export function readFilters(params) {
  const status = params.get("status") ?? "";
  const frequency = params.get("frequency") ?? "";
  const goal = params.get("goal") ?? "";
  const sort = params.get("sort") ?? "";
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    q: clean(params.get("q"), 80).toLowerCase(),
    status: STATUSES.includes(status) ? status : "",
    frequency: Object.hasOwn(QUESTIONS.frequency.options, frequency) ? frequency : "",
    goal: Object.hasOwn(QUESTIONS.goal.options, goal) ? goal : "",
    sort: Object.hasOwn(SORTS, sort) ? sort : "line",
    page: Number.isInteger(page) && page > 0 ? Math.min(page, 1000) : 1
  };
}

export function applyFilters(rows, positions, filters) {
  const matches = rows.filter((row) => {
    if (filters.status && row.status !== filters.status) return false;
    if (filters.frequency && row.frequency !== filters.frequency) return false;
    if (filters.goal && row.goal !== filters.goal) return false;
    if (filters.q && !`${row.name} ${row.email} ${row.city}`.toLowerCase().includes(filters.q)) return false;
    return true;
  });
  const statusOrder = { waiting: 0, invited: 1, archived: 2 };
  const byLine = (a, b) =>
    statusOrder[a.status] - statusOrder[b.status] ||
    (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0) ||
    b.joined_at.localeCompare(a.joined_at);
  const sorters = {
    line: byLine,
    newest: (a, b) => b.joined_at.localeCompare(a.joined_at),
    referrals: (a, b) => (b.referrals ?? 0) - (a.referrals ?? 0) || byLine(a, b)
  };
  return matches.sort(sorters[filters.sort]);
}

export function summarize(rows, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const active = rows.filter((row) => row.status !== "archived");
  const referred = active.filter((row) => row.referred_by);
  return {
    total: active.length,
    waiting: active.filter((row) => row.status === "waiting").length,
    invited: active.filter((row) => row.status === "invited").length,
    thisWeek: active.filter((row) => row.joined_at >= weekAgo).length,
    referredShare: active.length ? Math.round((referred.length / active.length) * 100) : 0
  };
}

export function topReferrers(rows, limit = 5) {
  return rows
    .filter((row) => (row.referrals ?? 0) > 0 && row.status !== "archived")
    .sort((a, b) => b.referrals - a.referrals || a.joined_at.localeCompare(b.joined_at))
    .slice(0, limit);
}

// A short feed of what happened lately, built from the saved signups.
export function recentActivity(rows, limit = 8) {
  const byCode = new Map(rows.map((row) => [row.referral_code, row]));
  const items = [];
  for (const row of rows) {
    const referrer = row.referred_by ? byCode.get(row.referred_by) : null;
    items.push({ at: row.joined_at, kind: referrer ? "referred" : "joined", row, referrer });
    if (row.status === "invited" && row.invited_at) items.push({ at: row.invited_at, kind: "invited", row });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// Spreadsheet apps run cells that start with these characters as formulas.
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows, positions) {
  const header = ["place_in_line", "name", "email", "status", "joined_at", "referrals", "referred_by", "referral_code", "runs", "wants", "city", "source"];
  const lines = rows.map((row) =>
    [
      positions.get(row.id) ?? "",
      row.name,
      row.email,
      row.status,
      row.joined_at,
      row.referrals ?? 0,
      row.referred_by,
      row.referral_code,
      QUESTIONS.frequency.options[row.frequency] ?? "",
      QUESTIONS.goal.options[row.goal] ?? "",
      row.city,
      row.source
    ]
      .map(csvCell)
      .join(",")
  );
  return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Storage. The owner's real list lives in the "signups" collection.
// server/demo.js provides a store with the same methods for the public demo.
// ---------------------------------------------------------------------------

// Fills in defaults so older rows and new rows look the same to the rest of the app.
export function toSignup(row) {
  return {
    id: row.id,
    email: row.email ?? "",
    name: row.name ?? "",
    status: STATUSES.includes(row.status) ? row.status : "waiting",
    joined_at: row.joined_at || row.created_at || "",
    invited_at: row.invited_at ?? "",
    referral_code: row.referral_code ?? "",
    referred_by: row.referred_by ?? "",
    // Not stored: filled in by withReferralCounts() whenever the whole list is read.
    referrals: 0,
    status_token: row.status_token ?? "",
    frequency: row.frequency ?? "",
    goal: row.goal ?? "",
    city: row.city ?? "",
    source: row.source ?? ""
  };
}

// Reads every row, 100 at a time (the most one query returns).
// The place-in-line page and the owner view need the whole list. The public
// landing page doesn't: it only uses countJoined() below.
export async function listAll(collection, query = {}) {
  const rows = [];
  let cursor;
  do {
    const page = await collection.list({ ...query, limit: 100, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor && rows.length < 20000);
  return rows;
}

export function signupStore(ctx) {
  const signups = () => ctx.data.collection(COLLECTION);
  return {
    async all() {
      return withReferralCounts((await listAll(signups())).map(toSignup));
    },
    // For the landing page's "N runners have already joined" line. Reads one
    // page instead of the whole list, so the busiest public page stays fast.
    // People the owner archived don't count.
    async countJoined() {
      const page = await signups().list({ limit: 100 });
      const count = page.rows.filter((row) => row.status !== "archived").length;
      return { count, more: Boolean(page.cursor) };
    },
    async get(id) {
      const row = await signups().get(id);
      return row ? toSignup(row) : null;
    },
    async findByEmail(email) {
      const page = await signups().list({ where: { email }, limit: 1 });
      return page.rows[0] ? toSignup(page.rows[0]) : null;
    },
    async findByCode(code) {
      const page = await signups().list({ where: { referral_code: code }, limit: 1 });
      return page.rows[0] ? toSignup(page.rows[0]) : null;
    },
    async create(fields) {
      return toSignup(await signups().create(fields));
    },
    async update(id, patch) {
      return toSignup(await signups().update(id, patch));
    }
  };
}

// Adds someone to the list. The friend who referred them gets credit through
// referred_by alone (see withReferralCounts), so this is a single write.
export async function joinWaitlist(store, values, now = new Date()) {
  if (await store.findByEmail(values.email)) throw new DuplicateSignupError();
  const referrer = values.ref ? await store.findByCode(values.ref) : null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fields = {
      email: values.email,
      name: values.name,
      status: "waiting",
      joined_at: now.toISOString(),
      referral_code: newReferralCode(),
      referred_by: referrer && referrer.email !== values.email ? referrer.referral_code : "",
      status_token: newToken(),
      source: referrer ? "friend" : values.source || "direct"
    };
    try {
      const signup = await store.create(fields);
      return { signup, referrer: fields.referred_by ? referrer : null };
    } catch (error) {
      if (error?.code !== "unique_conflict") throw error;
      // Either the email was taken a moment ago, or the random code collided. Retry only the second case.
      if (await store.findByEmail(values.email)) throw new DuplicateSignupError();
    }
  }
  throw new Error("Could not create a unique referral code.");
}

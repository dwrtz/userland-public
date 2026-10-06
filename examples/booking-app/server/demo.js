// Demo mode for the public demo at https://booking-demo.apps.userland.fun/.
//
// Everything that exists only for the public demo lives in this file. A real
// studio does not need any of it.
//
// What demo mode does:
// - Lets anyone open the owner pages (/studio) without signing in.
// - Keeps each visitor's bookings and edits private to that visitor. A visitor
//   gets a random key (the `v` query parameter) the first time they submit a
//   form. Rows they create are stored with that key in `demo_key`, and every
//   read filters on it, so one visitor never sees another visitor's details.
//   (Userland passes only its own session cookie to app code, so the key
//   travels in links and form actions instead of a cookie.)
// - Shows made-up sample lessons and bookings next to the visitor's own
//   requests. The first time a visitor changes a sample on the owner side,
//   the samples are copied into their private set (each copy records the
//   sample it came from in `demo_copy_of`), so edits never affect anyone else.
// - Deletes visitor rows a day after they were saved (`demo_expires_at`), and
//   marks every page noindex with a "Built with Userland" note that links to
//   the example page.
// - Caps how much one visitor can save (MAX_VISITOR_ROWS), so one visit can't
//   fill the demo's storage for everyone else.
//
// Demo mode is on only for requests to the hosts in DEMO_HOSTS: the demo's
// short address and, on purpose, the demo app's own app-id address, on both
// apps.userland.fun and userland.link, so every
// page of the demo deployment is marked noindex. Anywhere else, including the
// Userland address of your own copy and any custom domain, the owner pages require an app user with the "owner" role, so a copy
// of this example is never published with an open owner desk.
//
// To remove demo mode completely, delete this file and every line in index.js
// that ends with `// demo`. The demo_* fields in manifest.userland.json can
// stay: a real studio's rows always have an empty demo_key. See "Demo mode" in
// README.md.

import { openDays, studioTimeToDate } from "./schedule.js";

// The public demo's short address and the demo app's own address, on
// apps.userland.fun and on userland.link. They belong to the Userland demo deployment
// only; replace them if you publish your own demo.
export const DEMO_HOSTS = [
  "booking-demo.apps.userland.fun",
  "1pkr8yilzutyu2y0nid.apps.userland.fun",
  "booking-demo.userland.link",
  "1pkr8yilzutyu2y0nid.userland.link"
];

/** True when this request is for the public demo address. */
export function isDemoHost(url) {
  return DEMO_HOSTS.includes(url.hostname);
}

export const EXAMPLE_PAGE_URL = "https://userland.fun/examples/booking-app/";

const KEY_PARAM = "v";
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const KEEP_VISITOR_ROWS_HOURS = 24;
// Rows one visitor can have at once, across both collections: the 9 sample
// copies, plus their own requests (each with a time hold or two) and lessons.
export const MAX_VISITOR_ROWS = 60;
const SWEEP_BATCH = 20;
const DEMO_COLLECTIONS = ["services", "bookings"];

/** The visitor key from the URL, or null when this visitor has not changed anything yet. */
export function keyFromUrl(url) {
  const value = url.searchParams.get(KEY_PARAM);
  return value && KEY_PATTERN.test(value) ? value : null;
}

/** A new random visitor key: 16 random bytes, base64url encoded. */
export function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Adds the visitor key to an app path so the visitor keeps seeing their own records. */
export function withKey(path, key) {
  if (!key) return path;
  const [base, hash] = path.split("#");
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}${KEY_PARAM}=${key}${hash === undefined ? "" : `#${hash}`}`;
}

/** Starts a visitor's private records on their first change. chrome.link() picks up the new key. */
export function ensureKey(rc) {
  if (!rc.key) rc.key = newKey();
}

/** The starter lessons as made-up samples with fixed ids. */
export function sampleServices(starters) {
  return starters.map((service, index) => ({ ...service, id: `sample-service-${index + 1}`, sort_order: index + 1, active: true }));
}

/** The sample bookings for the sample lessons, on the next few open days. */
function currentSampleBookings(starters, now) {
  const days = openDays(now).slice(1);
  const pickSlot = (dayNumber, weekdayTime, saturdayTime, duration) => {
    const date = days[Math.min(dayNumber, days.length) - 1];
    const isSaturday = new Date(`${date}T12:00:00Z`).getUTCDay() === 6;
    const start = studioTimeToDate(date, isSaturday ? saturdayTime : weekdayTime);
    return { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + duration * 60000).toISOString() };
  };
  return sampleBookings(sampleServices(starters), now, pickSlot);
}

export const VISITOR_LIMIT_MESSAGE = {
  title: "That's plenty for one demo visit",
  text: "You've added a lot in this visit. Everything you added is cleared a day after you added it, so there's room again tomorrow."
};

/**
 * True when this visitor has saved as much as one demo visit may. Rows whose
 * day is up don't count, even before sweepDemoData gets to them.
 */
export async function atVisitorLimit(rc) {
  if (!rc.key) return false;
  const [bookings, services] = await Promise.all([visitorBookingRows(rc), visitorRows(rc.ctx.data.collection("services"), rc.key)]);
  return [...bookings, ...services].filter((row) => expiresAt(row) >= rc.now.getTime()).length >= MAX_VISITOR_ROWS;
}

/** The lessons a visitor sees: the samples until they change one, then their own copies. */
export function visitorServices(rows, starters) {
  return rows.length === 0 ? sampleServices(starters) : withoutExtraCopies(rows);
}

/**
 * The bookings a visitor sees. Until they change a sample booking, the samples
 * are shown next to their own requests. After that, their copies are shown instead.
 */
export function visitorBookings(rows, starters, now) {
  return rows.some(isSample) ? withoutExtraCopies(rows) : [...currentSampleBookings(starters, now), ...rows];
}

/** The visitor's rows in `bookings` (requests and time holds), read once per request. */
function visitorBookingRows(rc) {
  if (!rc.key) return Promise.resolve([]);
  rc.demoBookingRows ??= visitorRows(rc.ctx.data.collection("bookings"), rc.key);
  return rc.demoBookingRows;
}

/** Forgets this request's earlier read of the visitor's bookings, so the next one sees rows saved since. */
export function readAgain(rc) {
  rc.demoBookingRows = null;
}

/** Every booking the visitor sees: see visitorBookings. A visitor's rows are few (MAX_VISITOR_ROWS), so they are read in one go. */
export async function allBookings(rc, starters) {
  const rows = (await visitorBookingRows(rc)).filter((row) => row.status !== "hold");
  return visitorBookings(rows, starters, rc.now);
}

/**
 * The demo's version of findBookings in index.js: one page of the visitor's
 * bookings with `status`, ordered by lesson time. The cursor is an offset.
 */
export async function findBookings(rc, status, { direction, cursor, limit }, starters) {
  const sign = direction === "desc" ? -1 : 1;
  const matching = (await allBookings(rc, starters)).filter((booking) => booking.status === status).sort((a, b) => a.starts_at.localeCompare(b.starts_at) * sign);
  const offset = Number.parseInt(cursor ?? "0", 10) || 0;
  const next = offset + limit;
  return { rows: matching.slice(offset, next), cursor: next < matching.length ? String(next) : null };
}

/**
 * Before an owner-side change: copies the samples into the visitor's private
 * set so the change never affects anyone else, and clears out demo rows whose
 * day is up. Returns a map from sample id to the visitor's copy.
 */
export async function prepareChange(rc, collectionName, starters, newRef) {
  ensureKey(rc);
  const isBookings = collectionName === "bookings";
  const toRow = (sample) => {
    const { id, created_at, updated_at, data, ...fields } = sample;
    return isBookings ? { ...fields, ref: newRef() } : fields;
  };
  const [, copies] = await Promise.all([
    sweepDemoData(rc.ctx.data, rc.now),
    copySamplesForVisitor(rc.ctx.data.collection(collectionName), isBookings ? currentSampleBookings(starters, rc.now) : sampleServices(starters), rc.key, toRow, rc.now)
  ]);
  readAgain(rc); // The copies were just made.
  return copies;
}

const SAMPLE_REFS = ["WH-R7KQ2M", "WH-T3MB8P", "WH-H9LS4X", "WH-D2WX6C", "WH-G5NC3V"];

/** Made-up bookings shown in the owner inbox. Times are relative to today so the demo always looks current. */
export function sampleBookings(services, now, pickSlot) {
  // pickSlot(dayNumber, weekdayTime, saturdayTime, minutes) returns { starts_at, ends_at }
  // on the nth open day from tomorrow.
  const byName = Object.fromEntries(services.map((service) => [service.name, service]));
  const plans = [
    { service: "Piano lesson", day: 1, time: "16:00", saturday: "10:00", status: "new", receivedHoursAgo: 3, name: "Priya Raman", email: "priya.raman@example.com", phone: "", student: "Myself. Adult beginner, some reading from school", message: "Weekday afternoons suit me best. Is there parking nearby?" },
    { service: "First lesson", day: 2, time: "15:30", saturday: "09:30", status: "new", receivedHoursAgo: 9, name: "Tom Becker", email: "tom.becker@example.com", phone: "(555) 010-4417", student: "My son Leo, age 9, one year of piano", message: "" },
    { service: "Voice lesson", day: 1, time: "17:30", saturday: "11:30", status: "confirmed", receivedHoursAgo: 30, name: "Hannah Silva", email: "hannah.s@example.com", phone: "", student: "Myself. Preparing a community theatre audition", message: "The audition song is from Guys and Dolls. I'll bring the sheet music." },
    { service: "Extended lesson", day: 4, time: "17:00", saturday: "10:00", status: "confirmed", receivedHoursAgo: 50, name: "Daniel Moreau", email: "d.moreau@example.com", phone: "(555) 010-2290", student: "Myself. Returning player, about grade 5 years ago", message: "" },
    { service: "Piano lesson", day: 3, time: "18:00", saturday: "12:00", status: "declined", receivedHoursAgo: 72, name: "Grace Liu", email: "grace.liu@example.com", phone: "", student: "My daughter Mei, age 7, total beginner", message: "Could we do Sundays instead?" }
  ];
  return plans
    .filter((plan) => byName[plan.service])
    .map((plan, index) => {
      const service = byName[plan.service];
      const slot = pickSlot(plan.day, plan.time, plan.saturday, service.duration_minutes);
      const received = new Date(now.getTime() - plan.receivedHoursAgo * 60 * 60 * 1000).toISOString();
      const history = [{ at: received, status: "new", by: "sample" }];
      if (plan.status !== "new") {
        history.push({ at: new Date(Date.parse(received) + 2 * 60 * 60 * 1000).toISOString(), status: plan.status, by: "owner" });
      }
      return {
        id: `sample-booking-${index + 1}`,
        ref: SAMPLE_REFS[index],
        service_id: service.id,
        service_name: service.name,
        duration_minutes: service.duration_minutes,
        price_cents: service.price_cents,
        starts_at: slot.starts_at,
        ends_at: slot.ends_at,
        customer_name: plan.name,
        customer_email: plan.email,
        customer_phone: plan.phone,
        student_details: plan.student,
        message: plan.message,
        status: plan.status,
        history,
        created_at: received,
        updated_at: history.at(-1).at
      };
    });
}

/** True for bookings that started as demo samples (not submitted by this visitor). */
export function isSample(booking) {
  return Array.isArray(booking.history) && booking.history[0]?.by === "sample";
}

/** The demo-only fields saved on every row a visitor creates. */
export function visitorFields(key, now) {
  return { demo_key: key, demo_expires_at: new Date(now.getTime() + KEEP_VISITOR_ROWS_HOURS * 60 * 60 * 1000).toISOString() };
}

async function visitorRows(collection, key) {
  const rows = [];
  let cursor;
  do {
    const page = await collection.list({ where: { demo_key: key }, limit: 100, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor && rows.length < 500);
  return rows;
}

/**
 * The visitor's copy of each sample, keyed by sample id. If a sample was
 * copied twice (see copySamplesForVisitor), the oldest copy counts.
 */
function copiesBySample(rows) {
  const copies = new Map();
  const oldestFirst = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const row of oldestFirst) {
    if (row.demo_copy_of && !copies.has(row.demo_copy_of)) copies.set(row.demo_copy_of, row);
  }
  return copies;
}

/** Hides extra copies of a sample, keeping the one copySamplesForVisitor returns. Other rows pass through. */
export function withoutExtraCopies(rows) {
  const copies = copiesBySample(rows);
  return rows.filter((row) => !row.demo_copy_of || copies.get(row.demo_copy_of)?.id === row.id);
}

/**
 * Copies sample rows into the visitor's private set, once per visitor, and
 * returns a map from sample id to the visitor's copy.
 *
 * A double-clicked button can run this twice at the same moment, and both
 * requests may create copies. Userland data has no locks, so instead the
 * oldest copy of each sample always wins: this function returns it, and
 * withoutExtraCopies hides the others when pages are read. Extras are deleted
 * with the rest of the visitor's rows after a day.
 */
export async function copySamplesForVisitor(collection, samples, key, toRow, now) {
  const existing = copiesBySample(await visitorRows(collection, key));
  const missing = samples.filter((sample) => !existing.has(sample.id));
  if (missing.length === 0) return existing;
  await Promise.all(missing.map((sample) => collection.create({ ...toRow(sample), ...visitorFields(key, now), demo_copy_of: sample.id })));
  // Read again: a request running at the same moment may have made copies too.
  return copiesBySample(await visitorRows(collection, key));
}

/**
 * Deletes visitor rows whose day is up, a small batch per demo write.
 *
 * Rows are read oldest-expiry first (`demo_expires_at` ascending), so expired
 * rows are always on the first page however many newer rows exist. Rows
 * without `demo_key` belong to a real studio and are never touched.
 */
export async function sweepExpiredRows(collection, now = new Date()) {
  const page = await collection.list({ order_by: [{ field: "demo_expires_at", direction: "asc" }], limit: 100 });
  const expired = page.rows.filter((row) => row.demo_key && expiresAt(row) < now.getTime()).slice(0, SWEEP_BATCH);
  await Promise.all(expired.map((row) => collection.delete(row.id)));
  return expired.length;
}

/** Sweeps every demo collection. Called on each demo write. */
export async function sweepDemoData(data, now) {
  await Promise.all(DEMO_COLLECTIONS.map((name) => sweepExpiredRows(data.collection(name), now)));
}

// A row without demo_expires_at expires a day after it was created.
function expiresAt(row) {
  return Date.parse(row.demo_expires_at ?? "") || Date.parse(row.created_at) + KEEP_VISITOR_ROWS_HOURS * 60 * 60 * 1000;
}

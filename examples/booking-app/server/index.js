// Wrenhouse Music Studio: lesson booking on Userland.
//
// Public visitors browse lessons, request a time, and see a confirmation.
// The studio owner reviews requests, confirms, declines, or deletes them,
// clears out old ones, edits lessons, and reads recent activity under /studio.
//
// Data lives in two managed collections declared in manifest.userland.json:
// `services` (the lessons on offer) and `bookings` (lesson requests, plus the
// time holds described under "Double-booking protection" below).
// Demo-only behavior lives in demo.js. Every line in this file that exists // demo
// only for the public demo ends with a demo marker. Deleting those lines // demo
// and demo.js removes demo mode (see "Demo mode" in README.md). // demo

import * as demo from "./demo.js"; // demo
import { STUDIO_HOURS, openDays, overlaps, slotsForDay, timeBlocks } from "./schedule.js";
import * as views from "./views.js";

export const OWNER_ROLE = "owner";

// Which status changes the owner can make from each status.
export const TRANSITIONS = {
  new: ["confirmed", "declined"],
  confirmed: ["cancelled"],
  declined: ["new"],
  cancelled: ["new"]
};

// Lessons used for the demo and offered to a new studio as a starting point.
export const STARTER_SERVICES = [
  { name: "First lesson", summary: "Meet, play a little, and plan what comes next.", duration_minutes: 30, price_cents: 3500 },
  { name: "Piano lesson", summary: "Technique, reading, and pieces you love. Ages 7 and up.", duration_minutes: 45, price_cents: 6000 },
  { name: "Voice lesson", summary: "Breath, tone, and confidence for singers of any style.", duration_minutes: 45, price_cents: 6000 },
  { name: "Extended lesson", summary: "More time for auditions, exams, and adult players.", duration_minutes: 60, price_cents: 7800 }
];

const LIMITS = {
  customer_name: 80,
  customer_email: 254,
  customer_phone: 30,
  student_details: 200,
  message: 1000,
  body_bytes: 16 * 1024
};
// A plain address: letters, digits, and . _ + - before the @, and a domain
// after it. Characters like ? & % # are refused so an address can't smuggle
// extra recipients or text into the owner's "reply by email" link.
const EMAIL_PATTERN = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/u;
const LESSON_LENGTHS = [20, 30, 45, 60, 90];
const HOLDS_TIME = new Set(["new", "confirmed"]);
const DAY = 24 * 60 * 60 * 1000;

/**
 * Limits on unanswered ("new") requests. They stop a script from holding
 * every open time or filling the plan's storage with fake requests. When one
 * is reached, the booking page asks people to email the studio instead, and
 * the owner's inbox says booking is paused until some requests are answered.
 */
export const REQUEST_LIMITS = {
  waitingTotal: 30, // Unanswered requests at one time.
  waitingPerEmail: 3, // Unanswered requests from one email address.
  receivedPerDay: 15 // Unanswered requests received in the last 24 hours.
};

// Owner lists show this many requests per page.
const PAGE_SIZE = 25;
// "Clear out" deletes requests whose lesson time is this old, a batch per click.
// The batch keeps one click well inside the Free plan's 25 data calls per request.
export const CLEAR_OUT = { olderThanDays: 30, batch: 12 };
// Time holds for past lessons deleted per booking request (see sweepPastHolds).
const HOLD_SWEEP_BATCH = 5;

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * `demoMode` is "auto" in production; tests pass true or false.
 * Demo mode turns on only at the demo address (see DEMO_HOSTS in demo.js). // demo
 */
export function createApp({ demoMode = "auto", now = () => new Date() } = {}) {
  const app = {
    async fetch(request, ctx) {
      if (request.method === "HEAD") return await answerHead(request, ctx, app.fetch);
      const url = new URL(request.url);
      let isDemo = false;
      isDemo = demoMode === "auto" ? demo.isDemoHost(url) : demoMode; // demo
      const rc = requestContext({ request, ctx, url, demoMode: isDemo, now: now() });
      try {
        return await route(rc);
      } catch (error) {
        if (error?.code === "quota_exceeded") return await storageFull(rc, error);
        await ctx.log.error("request failed", { path: url.pathname, method: request.method, message: error instanceof Error ? error.message : String(error) });
        return html(rc, views.messagePage({ title: "Something went wrong", text: "Please try again in a moment.", chrome: rc.chrome }), { status: 500 });
      }
    }
  };
  return app;
}

export default createApp();

// ---------------------------------------------------------------------------
// Routing

async function route(rc) {
  const { request, url } = rc;
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  const method = request.method;
  const ownerPath = path === "/studio" || path.startsWith("/studio/");

  if (method === "POST" && !sameOrigin(request, url, { strict: ownerPath })) {
    return html(rc, views.messagePage({ title: "Request blocked", text: "This form must be sent from the studio's own pages.", chrome: rc.chrome }), { status: 403 });
  }

  if (path === "/" && method === "GET") return await showHome(rc);
  if (path === "/book" && method === "GET") return await showBookingForm(rc);
  if (path === "/book" && method === "POST") return await submitBooking(rc);
  if (path === "/booked" && method === "GET") return await showConfirmation(rc);

  if (ownerPath) {
    const gate = await requireOwner(rc);
    if (gate.response) return gate.response;
    rc.user = gate.user;
    if (path === "/studio" && method === "GET") return await showInbox(rc);
    if (path === "/studio/bookings/clear-out" && method === "POST") return await clearOutOldBookings(rc);
    const bookingMatch = path.match(/^\/studio\/bookings\/([^/]+)\/(status|delete)$/u);
    if (bookingMatch && method === "POST") {
      const id = decodeURIComponent(bookingMatch[1]);
      return bookingMatch[2] === "status" ? await updateBookingStatus(rc, id) : await deleteBooking(rc, id);
    }
    if (path === "/studio/lessons" && method === "GET") return await showLessons(rc);
    if (path === "/studio/lessons" && method === "POST") return await saveLesson(rc, "new");
    if (path === "/studio/lessons/starter" && method === "POST") return await addStarterLessons(rc);
    const lessonMatch = path.match(/^\/studio\/lessons\/([^/]+)$/u);
    if (lessonMatch && method === "POST") return await saveLesson(rc, decodeURIComponent(lessonMatch[1]));
    if (path === "/studio/activity" && method === "GET") return await showActivity(rc);
  }

  return html(rc, views.messagePage({ title: "Page not found", text: "That page isn't here. It may have moved.", chrome: rc.chrome }), { status: 404 });
}

function requestContext({ request, ctx, url, demoMode, now }) {
  const rc = { request, ctx, url, demoMode, now, key: null, user: null };
  if (demoMode) rc.key = demo.keyFromUrl(url); // demo
  rc.chrome = chromeFor(rc);
  return rc;
}

function chromeFor(rc) {
  const chrome = { demo: rc.demoMode, examplePageUrl: "", link: (path) => path };
  if (rc.demoMode) Object.assign(chrome, { examplePageUrl: demo.EXAMPLE_PAGE_URL, link: (path) => demo.withKey(path, rc.key) }); // demo
  return chrome;
}

/**
 * Which records a request reads and writes. Every studio record has
 * `demo_key: ""`, and every query filters on it.
 * A demo visitor's scope is their key, or null before their first change. // demo
 */
function scopeOf(rc) {
  if (rc.demoMode) return rc.key; // demo
  return "";
}

/** True when a stored row belongs to this request's scope. */
function inScope(rc, row) {
  return (row.demo_key ?? "") === scopeOf(rc);
}

/** Fields saved on every new row, marking it as the studio's own. */
function scopeFields(rc) {
  if (rc.demoMode) return demo.visitorFields(rc.key, rc.now); // demo
  return { demo_key: "" };
}

// ---------------------------------------------------------------------------
// Owner gate

/**
 * Owner pages need a signed-in app user with the "owner" role. Signed-out
 * visitors are sent to Userland's built-in sign-in page and brought back after.
 * currentUser() is used instead of requireRole() so a missing session becomes
 * a friendly redirect rather than an error.
 */
async function requireOwner(rc) {
  if (rc.demoMode) return { user: null }; // demo
  const user = await rc.ctx.auth.currentUser(rc.request);
  if (!user) {
    const returnTo = rc.request.method === "GET" ? `${rc.url.pathname}${rc.url.search}` : "/studio";
    return { response: redirect(`/_userland/auth/login?return_to=${encodeURIComponent(returnTo)}`) };
  }
  if (!user.roles.includes(OWNER_ROLE)) {
    return { response: html(rc, views.forbiddenPage({ chrome: rc.chrome }), { status: 403, area: "studio" }) };
  }
  return { user };
}

/**
 * Rejects form posts sent from other sites, including other apps on
 * apps.userland.fun (they share the owner's sign-in cookie's site) and
 * sandboxed pages that send `Origin: null`.
 *
 * Owner forms (`strict`) must prove they came from this app: an Origin header
 * for this host, or, from a browser that leaves Origin out,
 * `Sec-Fetch-Site: same-origin`. The public booking form also accepts posts
 * with neither header (older browsers), since it doesn't use the sign-in cookie.
 */
function sameOrigin(request, url, { strict }) {
  const origin = request.headers.get("origin");
  if (origin === null) return strict ? request.headers.get("sec-fetch-site") === "same-origin" : true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data access
//
// Lists are read with indexed queries, one status at a time, so a studio's
// growing history never pushes new requests out of view. Queries use the
// by_scope_status index: `demo_key`, `status`, and `starts_at`.

async function loadServices(rc, { includeHidden = false } = {}) {
  const scope = scopeOf(rc);
  const collection = rc.ctx.data.collection("services");
  let services = [];
  let cursor = null;
  while (scope !== null) {
    const page = await collection.list({ where: { demo_key: scope }, order_by: [{ field: "sort_order", direction: "asc" }], limit: 100, ...(cursor ? { cursor } : {}) });
    services.push(...page.rows);
    cursor = page.cursor;
    if (!cursor) break;
  }
  if (rc.demoMode) services = demo.visitorServices(services, STARTER_SERVICES); // demo
  return includeHidden ? services : services.filter((service) => service.active);
}

/** One page of requests with `status`, ordered by lesson time. Pass the returned `cursor` back to read the next page. */
async function findBookings(rc, status, { direction = "asc", cursor = null, limit = PAGE_SIZE } = {}) {
  if (rc.demoMode) return await demo.findBookings(rc, status, { direction, cursor, limit }, STARTER_SERVICES); // demo
  const page = await rc.ctx.data.collection("bookings").list({ where: { demo_key: scopeOf(rc), status }, order_by: [{ field: "starts_at", direction }], limit, ...(cursor ? { cursor } : {}) });
  return { rows: page.rows, cursor: page.cursor ?? null };
}

/** Every request with `status`, soonest first. Used for unanswered requests, which REQUEST_LIMITS keeps few. */
async function allBookings(rc, status) {
  const rows = [];
  let cursor = null;
  do {
    const page = await findBookings(rc, status, { cursor, limit: 100 });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

/**
 * Requests with `status` whose lesson hasn't ended, soonest first. Reads
 * latest lesson first and stops a day before now, so it only ever reads the
 * booking window, however long the studio's history gets.
 */
async function upcomingBookings(rc, status) {
  const now = rc.now.getTime();
  const rows = [];
  let cursor = null;
  do {
    const page = await findBookings(rc, status, { direction: "desc", cursor, limit: 100 });
    rows.push(...page.rows);
    const last = page.rows.at(-1);
    cursor = last && Date.parse(last.starts_at) > now - DAY ? page.cursor : null;
  } while (cursor);
  return rows.filter((row) => Date.parse(row.ends_at) > now).reverse();
}

/** A page of confirmed lessons that have ended, latest first. Skips past upcoming lessons, which come first in that order. */
async function pastLessons(rc, cursor) {
  let next = cursor;
  do {
    const page = await findBookings(rc, "confirmed", { direction: "desc", cursor: next });
    const past = page.rows.filter((row) => Date.parse(row.ends_at) <= rc.now.getTime());
    next = page.cursor;
    if (past.length > 0) return { rows: past, cursor: next };
  } while (next);
  return { rows: [], cursor: null };
}

/**
 * The requests changed most recently, for the activity page. Without
 * `order_by`, rows come back most recently changed first. `since` is set when
 * older rows exist: every change at or after it is in `rows`.
 */
async function recentlyChanged(rc) {
  if (rc.demoMode) return { rows: await demo.allBookings(rc, STARTER_SERVICES), since: null }; // demo
  const page = await rc.ctx.data.collection("bookings").list({ where: { demo_key: scopeOf(rc) }, limit: 100 });
  const rows = page.rows.filter((row) => row.status !== "hold");
  const latestChange = (row) => (Array.isArray(row.history) && row.history.at(-1)?.at) || row.updated_at;
  const since = page.cursor && rows.length ? rows.map(latestChange).sort()[0] : null;
  return { rows, since };
}

function receivedAt(booking) {
  return (Array.isArray(booking.history) && booking.history[0]?.at) || booking.created_at;
}

/** Why a new request can't be taken now ("email" or "busy"), or "" when it can. `waiting` is every unanswered request. */
function requestLimitReached(waiting, email, now) {
  if (email && waiting.filter((booking) => booking.customer_email === email).length >= REQUEST_LIMITS.waitingPerEmail) return "email";
  if (waiting.length >= REQUEST_LIMITS.waitingTotal) return "busy";
  const today = waiting.filter((booking) => Date.parse(receivedAt(booking)) > now.getTime() - DAY);
  if (today.length >= REQUEST_LIMITS.receivedPerDay) return "busy";
  return "";
}

function newRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `WH-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/** A reference no saved request uses yet. Clashes are very unlikely (one in a billion), but cheap to rule out. */
async function unusedRef(collection) {
  let ref = newRef();
  for (let tries = 0; tries < 5 && (await collection.list({ where: { ref }, limit: 1 })).rows.length > 0; tries += 1) ref = newRef();
  return ref;
}

// ---------------------------------------------------------------------------
// Double-booking protection
//
// A request that holds time ("new" or "confirmed") also owns one hold row per
// half-hour block its lesson touches, in the bookings collection with
// `status: "hold"`. Each hold's `hold` key is unique (the by_hold index), and
// Userland enforces unique keys atomically. So when two people ask for
// overlapping times at the same moment, only one of them can create the holds;
// the other gets `unique_conflict` and is told the time was just taken.
// (A data transaction groups the writes but does not stop two requests from
// running at once, so it can't do this job alone.)
//
// Holds are given back when a request is declined, cancelled, or deleted, and
// taken again when the owner moves a request back to new. Holds for lessons
// that are over are deleted a few at a time (sweepPastHolds).

function holdKey(rc, blockStart) {
  return `${scopeOf(rc)}|${blockStart}`;
}

async function holderOf(collection, hold) {
  const [row] = (await collection.list({ where: { hold }, limit: 1 })).rows;
  return row?.hold_for ?? null;
}

/**
 * Takes the holds for `booking`'s time. Returns false, and gives back any
 * holds it took, when another request already holds part of that time. Holds
 * this request already owns count as taken.
 */
async function takeHolds(rc, collection, booking) {
  const taken = [];
  const giveBack = () => Promise.all(taken.map((row) => collection.delete(row.id)));
  for (const block of timeBlocks(booking.starts_at, booking.ends_at)) {
    const hold = holdKey(rc, block.starts_at);
    try {
      taken.push(await collection.create({ hold, hold_for: booking.ref, status: "hold", starts_at: block.starts_at, ends_at: block.ends_at, ...scopeFields(rc) }));
    } catch (error) {
      if (error?.code !== "unique_conflict") {
        await giveBack();
        throw error;
      }
      if ((await holderOf(collection, hold)) === booking.ref) continue;
      await giveBack();
      return false;
    }
  }
  return true;
}

/** Gives back the holds `booking` owns, so its time can be booked again. */
async function releaseHolds(rc, collection, booking) {
  await Promise.all(
    timeBlocks(booking.starts_at, booking.ends_at).map(async (block) => {
      const [row] = (await collection.list({ where: { hold: holdKey(rc, block.starts_at) }, limit: 1 })).rows;
      if (row && row.hold_for === booking.ref) await collection.delete(row.id);
    })
  );
}

/**
 * Makes sure `booking` holds its time before it's confirmed or reopened.
 * Reopening a declined or cancelled request first checks the calendar,
 * since the time may have gone to someone else meanwhile. False when the
 * time is taken.
 */
async function holdTime(rc, collection, booking) {
  if (!HOLDS_TIME.has(booking.status)) {
    const [waiting, confirmed] = await Promise.all([upcomingBookings(rc, "new"), upcomingBookings(rc, "confirmed")]);
    if ([...waiting, ...confirmed].some((other) => other.id !== booking.id && overlaps(other, booking))) return false;
  }
  return await takeHolds(rc, collection, booking);
}

/** Deletes a few holds for lessons that are over. They no longer protect anything and count toward the plan's storage. */
async function sweepPastHolds(rc) {
  const collection = rc.ctx.data.collection("bookings");
  const page = await collection.list({ where: { demo_key: scopeOf(rc), status: "hold" }, order_by: [{ field: "starts_at", direction: "asc" }], limit: HOLD_SWEEP_BATCH });
  const past = page.rows.filter((row) => Date.parse(row.ends_at) <= rc.now.getTime());
  await Promise.all(past.map((row) => collection.delete(row.id)));
}

// ---------------------------------------------------------------------------
// Public pages

async function showHome(rc) {
  const services = await loadServices(rc);
  return html(rc, views.homePage({ services, chrome: rc.chrome }), {
    title: "",
    description: `${views.STUDIO.fullName}: one-to-one piano and voice lessons for children and adults. Choose a lesson and request a time online.`
  });
}

function bookingDays(busy, service, now) {
  const earliest = now.getTime() + STUDIO_HOURS.minNoticeHours * 60 * 60 * 1000;
  return openDays(now)
    .map((date) => {
      const slots = service ? slotsForDay(date, service.duration_minutes, busy, now) : [];
      return { date, slots, open: slots.some((slot) => slot.available) };
    })
    .filter((day) => day.slots.some((slot) => Date.parse(slot.starts_at) >= earliest)); // Skip days inside the notice period.
}

/** Requests that hold a time on the calendar: unanswered and confirmed lessons that haven't ended. */
async function busyTimes(rc) {
  const [waiting, confirmed] = await Promise.all([upcomingBookings(rc, "new"), upcomingBookings(rc, "confirmed")]);
  return [...waiting, ...confirmed];
}

async function renderBookingForm(rc, { serviceId, date, form = {}, errors = {}, status = 200 }) {
  const [services, busy] = await Promise.all([loadServices(rc), busyTimes(rc)]);
  const selected = services.find((service) => service.id === serviceId) ?? services[0] ?? null;
  const days = bookingDays(busy, selected, rc.now);
  const chosen = days.find((day) => day.date === date && day.open) ?? days.find((day) => day.open);
  const body = views.bookPage({
    services,
    selected,
    days,
    selectedDate: chosen?.date ?? "",
    slots: chosen?.slots ?? [],
    form,
    errors,
    chrome: rc.chrome
  });
  return html(rc, body, { title: "Book a lesson", current: "book", status, description: "Request a piano or voice lesson time online." });
}

async function showBookingForm(rc) {
  return await renderBookingForm(rc, { serviceId: rc.url.searchParams.get("service"), date: rc.url.searchParams.get("date") });
}

async function readForm(request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > LIMITS.body_bytes) return null;
  const text = await request.text();
  if (text.length > LIMITS.body_bytes) return null;
  const values = {};
  for (const [key, value] of new URLSearchParams(text)) values[key] = value;
  return values;
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max + 1);
}

export function validateBooking(input) {
  const form = {
    service_id: clean(input.service_id, 100),
    date: clean(input.date, 10),
    time: clean(input.time, 5),
    customer_name: clean(input.customer_name, LIMITS.customer_name),
    customer_email: clean(input.customer_email, LIMITS.customer_email).toLowerCase(),
    customer_phone: clean(input.customer_phone, LIMITS.customer_phone),
    student_details: clean(input.student_details, LIMITS.student_details),
    message: String(input.message ?? "").trim().slice(0, LIMITS.message + 1)
  };
  const errors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(form.date)) errors.time = "Please pick a day.";
  else if (!/^\d{2}:\d{2}$/u.test(form.time)) errors.time = "Please pick a start time.";
  if (!form.customer_name) errors.customer_name = "Please enter your name.";
  else if (form.customer_name.length > LIMITS.customer_name) errors.customer_name = `Please keep your name under ${LIMITS.customer_name} characters.`;
  if (!EMAIL_PATTERN.test(form.customer_email) || form.customer_email.length > LIMITS.customer_email) errors.customer_email = "Please enter an email address like name@example.com.";
  if (form.customer_phone && !/^[\d\s()+.-]{7,30}$/u.test(form.customer_phone)) errors.customer_phone = "Please enter a phone number using digits, spaces, or + ( ) -.";
  if (!form.student_details) errors.student_details = "Please tell us who the lesson is for.";
  else if (form.student_details.length > LIMITS.student_details) errors.student_details = `Please keep this under ${LIMITS.student_details} characters.`;
  if (form.message.length > LIMITS.message) errors.message = `Please keep your message under ${LIMITS.message} characters.`;
  return { form, errors };
}

async function submitBooking(rc) {
  const input = await readForm(rc.request);
  if (!input) return html(rc, views.messagePage({ title: "That request was too long", text: "Please shorten your message and try again.", chrome: rc.chrome, linkHref: "/book", linkLabel: "Back to booking" }), { status: 413 });

  // Honeypot: people never see the "company" field, so only bots fill it in.
  if (input.company) {
    await rc.ctx.log.warn("booking request ignored", { reason: "honeypot" });
    return html(rc, views.thanksPage(), { title: "Request sent" });
  }

  const { form, errors: fieldErrors } = validateBooking(input);
  const services = await loadServices(rc);
  const service = services.find((item) => item.id === form.service_id);
  // The lesson comes first on the form, so its error is listed first too.
  const errors = service ? fieldErrors : { service_id: "Please choose a lesson.", ...fieldErrors };

  if (Object.keys(errors).length > 0) {
    return await renderBookingForm(rc, { serviceId: form.service_id, date: form.date, form, errors, status: 422 });
  }

  if (rc.demoMode) demo.ensureKey(rc); // demo
  if (rc.demoMode && (await demo.atVisitorLimit(rc))) return html(rc, views.messagePage({ ...demo.VISITOR_LIMIT_MESSAGE, chrome: rc.chrome }), { title: "Demo limit reached", status: 429 }); // demo
  const demoCleanup = rc.demoMode ? demo.sweepDemoData(rc.ctx.data, rc.now) : null; // demo

  // Unanswered requests are few (REQUEST_LIMITS), so read them all.
  const [waiting, confirmed] = await Promise.all([allBookings(rc, "new"), upcomingBookings(rc, "confirmed")]);
  const limit = requestLimitReached(waiting, form.customer_email, rc.now);
  if (limit) {
    await demoCleanup; // demo
    return await refuseRequest(rc, limit, waiting.length);
  }

  // A quick check against the calendar, for a friendly message in the usual
  // case. The holds below are what actually prevent a double booking.
  const busy = [...waiting.filter((booking) => Date.parse(booking.ends_at) > rc.now.getTime()), ...confirmed];
  const slot = slotsForDay(form.date, service.duration_minutes, busy, rc.now).find((item) => item.time === form.time);
  let booking = null;
  if (openDays(rc.now).includes(form.date) && slot?.available) {
    const collection = rc.ctx.data.collection("bookings");
    const createdAt = rc.now.toISOString();
    const request = {
      ref: await unusedRef(collection),
      service_id: service.id,
      service_name: service.name,
      duration_minutes: service.duration_minutes,
      price_cents: service.price_cents,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      customer_name: form.customer_name,
      customer_email: form.customer_email,
      customer_phone: form.customer_phone,
      student_details: form.student_details,
      message: form.message,
      status: "new",
      history: [{ at: createdAt, status: "new", by: "customer" }],
      ...scopeFields(rc)
    };
    booking = await rc.ctx.data.transaction(async (tx) => {
      const bookings = tx.collection("bookings");
      if (!(await takeHolds(rc, bookings, request))) return null;
      try {
        return await bookings.create(request);
      } catch (error) {
        await releaseHolds(rc, bookings, request);
        throw error;
      }
    });
  }
  await demoCleanup; // demo

  if (!booking) {
    return await renderBookingForm(rc, {
      serviceId: service.id,
      date: form.date,
      form: { ...form, time: "" },
      errors: { time: "Sorry, that time was just taken. Please pick another." },
      status: 409
    });
  }

  // Requests sent at the same moment all pass the limit check above before
  // any of them is saved. Now that this one is saved, check again and take it
  // back if it went over, so a burst of requests can't get past REQUEST_LIMITS.
  if (rc.demoMode) demo.readAgain(rc); // demo
  const others = (await allBookings(rc, "new")).filter((other) => other.id !== booking.id);
  const over = requestLimitReached(others, form.customer_email, rc.now);
  if (over) {
    const bookings = rc.ctx.data.collection("bookings");
    await releaseHolds(rc, bookings, booking);
    await bookings.delete(booking.id);
    return await refuseRequest(rc, over, others.length);
  }

  await sweepPastHolds(rc);
  // Log ids only. Contact details stay in managed data, not in the activity log.
  await rc.ctx.log.info("booking requested", { booking_id: booking.id, ref: booking.ref, service_id: service.id, starts_at: booking.starts_at, demo: rc.demoMode });
  return redirect(rc.chrome.link(`/booked?ref=${encodeURIComponent(booking.ref)}`));
}

/** The page for a request that REQUEST_LIMITS turns away. `limit` is what requestLimitReached returned. */
async function refuseRequest(rc, limit, waitingCount) {
  await rc.ctx.log.warn("booking request refused", { reason: limit === "email" ? "waiting_per_email" : "waiting_limit", waiting: waitingCount });
  return html(rc, views.requestLimitPage({ reason: limit, chrome: rc.chrome }), { title: "Please get in touch", status: 429 });
}

async function showConfirmation(rc) {
  const ref = clean(rc.url.searchParams.get("ref"), 20);
  let booking = null;
  if (ref && scopeOf(rc) !== null) {
    const page = await rc.ctx.data.collection("bookings").list({ where: { ref }, limit: 10 });
    booking = page.rows.find((row) => inScope(rc, row)) ?? null;
  }
  if (!booking) {
    return html(rc, views.messagePage({ title: "We couldn't find that request", text: "The link may be incomplete. If you sent a request, it's safe with us and you'll hear back soon.", chrome: rc.chrome }), { status: 404, noindex: true });
  }
  // The page shows a first name and a lesson time, so search engines are asked to skip it.
  return html(rc, views.confirmationPage({ booking, chrome: rc.chrome }), { title: "Request received", noindex: true });
}

/** Shown when a new row would go over the plan's storage limit. */
async function storageFull(rc, error) {
  await rc.ctx.log.warn("storage limit reached", { path: rc.url.pathname, message: error instanceof Error ? error.message : String(error) });
  const owner = rc.url.pathname.startsWith("/studio");
  return html(rc, views.storageFullPage({ owner, chrome: rc.chrome }), { status: 503, area: owner ? "studio" : "public", noindex: true });
}

// ---------------------------------------------------------------------------
// Studio pages (owner only)

/** Whether the owner can delete a request: anything except a confirmed lesson that is still to come (cancel it first). */
export function canDelete(booking, now) {
  return booking.status !== "confirmed" || Date.parse(booking.ends_at) <= now.getTime();
}

async function showInbox(rc) {
  let isSample = () => false;
  if (rc.demoMode) isSample = demo.isSample; // demo
  const tab = views.INBOX_TABS.find((item) => item.key === rc.url.searchParams.get("show")) ?? views.INBOX_TABS[0];
  const after = clean(rc.url.searchParams.get("after"), 200) || null;
  const paged = tab.key !== "new" && tab.key !== "upcoming";
  const [waiting, upcoming] = await Promise.all([allBookings(rc, "new"), upcomingBookings(rc, "confirmed")]);
  let page = { rows: tab.key === "new" ? waiting : upcoming, cursor: null };
  try {
    if (tab.key === "past") page = await pastLessons(rc, after);
    else if (paged) page = await findBookings(rc, tab.key, { direction: "desc", cursor: after });
  } catch (error) {
    if (!after) throw error;
    return redirect(rc.chrome.link(`/studio?show=${tab.key}`)); // A "Show more" link that no longer works starts over.
  }
  const body = views.inboxPage({
    bookings: page.rows,
    tab,
    counts: { new: waiting.length, upcoming: upcoming.length },
    paused: requestLimitReached(waiting, "", rc.now) === "busy",
    nextPage: page.cursor,
    firstPage: !paged || !after,
    transitions: TRANSITIONS,
    canDelete: (booking) => canDelete(booking, rc.now),
    updatedId: rc.url.searchParams.get("updated"),
    notice: {
      kind: rc.url.searchParams.get("notice"),
      count: Number.parseInt(rc.url.searchParams.get("count") ?? "0", 10) || 0,
      more: rc.url.searchParams.get("more") === "1"
    },
    clearOut: CLEAR_OUT,
    chrome: rc.chrome,
    isSample,
    now: rc.now
  });
  return html(rc, body, { title: "Booking requests", area: "studio", current: "requests" });
}

function inboxTab(input) {
  return views.INBOX_TABS.some((item) => item.key === input.show) ? input.show : "new";
}

async function updateBookingStatus(rc, bookingId) {
  const input = (await readForm(rc.request)) ?? {};
  const next = String(input.status ?? "");
  const show = inboxTab(input);

  let id = bookingId;
  if (rc.demoMode) id = (await demo.prepareChange(rc, "bookings", STARTER_SERVICES, newRef)).get(bookingId)?.id ?? bookingId; // demo
  const collection = rc.ctx.data.collection("bookings");
  const booking = await collection.get(id);
  if (!booking || !inScope(rc, booking) || booking.status === "hold") {
    return html(rc, views.messagePage({ title: "Booking not found", text: "It may have been removed.", chrome: rc.chrome, linkHref: "/studio", linkLabel: "Back to requests" }), { status: 404, area: "studio" });
  }
  if (!(TRANSITIONS[booking.status] ?? []).includes(next)) {
    return redirect(rc.chrome.link(`/studio?show=${show}#booking-${id}`));
  }
  // Confirming or reopening a request needs its time to be free.
  if (HOLDS_TIME.has(next) && !(await holdTime(rc, collection, booking))) {
    await rc.ctx.log.info("booking status change refused", { booking_id: id, from: booking.status, to: next, reason: "time_taken", demo: rc.demoMode });
    return redirect(rc.chrome.link(`/studio?show=${show}&notice=taken#booking-${id}`));
  }
  const history = [...(Array.isArray(booking.history) ? booking.history : []), { at: rc.now.toISOString(), status: next, by: rc.user?.email ?? "owner" }];
  await collection.update(id, { status: next, history });
  if (!HOLDS_TIME.has(next)) await releaseHolds(rc, collection, booking);
  await rc.ctx.log.info("booking status changed", { booking_id: id, from: booking.status, to: next, demo: rc.demoMode });
  return redirect(rc.chrome.link(`/studio?show=${show}&updated=${encodeURIComponent(id)}#booking-${id}`));
}

async function deleteBooking(rc, bookingId) {
  const input = (await readForm(rc.request)) ?? {};
  const show = inboxTab(input);
  const collection = rc.ctx.data.collection("bookings");
  const booking = await collection.get(bookingId);
  if (!booking || !inScope(rc, booking) || booking.status === "hold") {
    return html(rc, views.messagePage({ title: "Booking not found", text: "It may have been removed already.", chrome: rc.chrome, linkHref: `/studio?show=${show}`, linkLabel: "Back to requests" }), { status: 404, area: "studio" });
  }
  if (rc.demoMode && demo.isSample(booking)) return redirect(rc.chrome.link(`/studio?show=${show}#booking-${booking.id}`)); // demo
  if (!canDelete(booking, rc.now)) return redirect(rc.chrome.link(`/studio?show=${show}#booking-${booking.id}`));
  if (HOLDS_TIME.has(booking.status)) await releaseHolds(rc, collection, booking);
  await collection.delete(booking.id);
  await rc.ctx.log.info("booking deleted", { booking_id: booking.id, status: booking.status, demo: rc.demoMode });
  return redirect(rc.chrome.link(`/studio?show=${show}&notice=deleted`));
}

/** Deletes a batch of requests whose lesson time is more than CLEAR_OUT.olderThanDays ago, oldest first. */
async function clearOutOldBookings(rc) {
  const input = (await readForm(rc.request)) ?? {};
  const show = inboxTab(input);
  const status = { past: "confirmed", declined: "declined", cancelled: "cancelled" }[show];
  if (!status) return redirect(rc.chrome.link(`/studio?show=${show}`));
  const cutoff = rc.now.getTime() - CLEAR_OUT.olderThanDays * DAY;
  const page = await findBookings(rc, status, { limit: CLEAR_OUT.batch });
  let old = page.rows.filter((row) => Date.parse(row.ends_at) < cutoff);
  if (rc.demoMode) old = old.filter((row) => !demo.isSample(row)); // demo
  const collection = rc.ctx.data.collection("bookings");
  await Promise.all(old.map((row) => collection.delete(row.id)));
  await sweepPastHolds(rc);
  const more = old.length > 0 && old.length === page.rows.length && page.cursor !== null;
  await rc.ctx.log.info("old bookings cleared", { status, count: old.length, demo: rc.demoMode });
  return redirect(rc.chrome.link(`/studio?show=${show}&notice=cleared&count=${old.length}${more ? "&more=1" : ""}`));
}

async function showLessons(rc, extra = {}) {
  const services = await loadServices(rc, { includeHidden: true });
  const body = views.lessonsPage({
    services,
    savedId: rc.url.searchParams.get("saved"),
    chrome: rc.chrome,
    showStarter: !rc.demoMode && services.length === 0,
    ...extra
  });
  return html(rc, body, { title: "Lessons", area: "studio", current: "lessons", status: extra.status ?? 200 });
}

export function validateLesson(input) {
  const form = {
    name: clean(input.name, 60),
    summary: clean(input.summary, 240),
    duration_minutes: Number.parseInt(String(input.duration_minutes ?? ""), 10),
    price: clean(input.price, 8).replace(/^\$/u, ""),
    active: input.active === "yes"
  };
  const errors = {};
  if (!form.name) errors.name = "Please give the lesson a name.";
  else if (form.name.length > 60) errors.name = "Please keep the name under 60 characters.";
  if (form.summary.length > 240) errors.summary = "Please keep the description under 240 characters.";
  if (!LESSON_LENGTHS.includes(form.duration_minutes)) errors.duration_minutes = "Please choose a length.";
  const price = Number(form.price);
  if (!/^\d{1,4}(\.\d{1,2})?$/u.test(form.price) || price > 2000) errors.price = "Please enter a price like 60 or 62.50.";
  return { form, errors, values: { name: form.name, summary: form.summary, duration_minutes: form.duration_minutes, price_cents: Math.round(price * 100), active: form.active } };
}

async function saveLesson(rc, serviceId) {
  const input = (await readForm(rc.request)) ?? {};
  const { form, errors, values } = validateLesson(input);
  if (Object.keys(errors).length > 0) {
    return await showLessons(rc, { form: { ...form, id: serviceId }, errors, status: 422 });
  }

  if (rc.demoMode && serviceId === "new" && (await demo.atVisitorLimit(rc))) return html(rc, views.messagePage({ ...demo.VISITOR_LIMIT_MESSAGE, chrome: rc.chrome, linkHref: "/studio/lessons", linkLabel: "Back to lessons" }), { status: 429, area: "studio" }); // demo
  let copies = new Map();
  if (rc.demoMode) copies = await demo.prepareChange(rc, "services", STARTER_SERVICES, newRef); // demo
  const collection = rc.ctx.data.collection("services");
  let saved;
  if (serviceId === "new") {
    const existing = await loadServices(rc, { includeHidden: true });
    const sortOrder = Math.max(0, ...existing.map((service) => service.sort_order ?? 0)) + 1;
    saved = await collection.create({ ...values, sort_order: sortOrder, ...scopeFields(rc) });
    await rc.ctx.log.info("lesson added", { service_id: saved.id, demo: rc.demoMode });
  } else {
    const id = copies.get(serviceId)?.id ?? serviceId;
    const service = await collection.get(id);
    if (!service || !inScope(rc, service)) {
      return html(rc, views.messagePage({ title: "Lesson not found", text: "It may have been removed.", chrome: rc.chrome, linkHref: "/studio/lessons", linkLabel: "Back to lessons" }), { status: 404, area: "studio" });
    }
    saved = await collection.update(id, values);
    await rc.ctx.log.info("lesson updated", { service_id: id, demo: rc.demoMode });
  }
  return redirect(rc.chrome.link(`/studio/lessons?saved=${encodeURIComponent(saved.id)}#service-${saved.id}`));
}

async function addStarterLessons(rc) {
  const existing = await loadServices(rc, { includeHidden: true });
  if (!rc.demoMode && existing.length === 0) {
    const collection = rc.ctx.data.collection("services");
    for (const [index, service] of STARTER_SERVICES.entries()) {
      await collection.create({ ...service, sort_order: index + 1, active: true, ...scopeFields(rc) });
    }
    await rc.ctx.log.info("starter lessons added", { count: STARTER_SERVICES.length });
  }
  return redirect(rc.chrome.link("/studio/lessons"));
}

const ACTIVITY_SHOWN = 40;

async function showActivity(rc) {
  const { rows, since } = await recentlyChanged(rc);
  const entries = rows
    .flatMap((booking) => (Array.isArray(booking.history) ? booking.history : []).map((entry) => ({ entry, booking })))
    .filter(({ entry }) => since === null || String(entry.at) >= since)
    .sort((a, b) => String(b.entry.at).localeCompare(String(a.entry.at)))
    .slice(0, ACTIVITY_SHOWN);
  return html(rc, views.activityPage({ entries, chrome: rc.chrome, now: rc.now }), { title: "Activity", area: "studio", current: "activity" });
}

// ---------------------------------------------------------------------------
// Responses

function html(rc, body, { status = 200, title, area = "public", current = "", description = "", noindex = false } = {}) {
  const page = views.layout({ title, description, body, chrome: rc.chrome, area, current, user: rc.user, noindex });
  return new Response(page, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Owner pages and confirmations include personal details, so nothing is cached.
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff"
    }
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

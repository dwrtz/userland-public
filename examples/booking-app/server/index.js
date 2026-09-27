// Wrenhouse Music Studio: lesson booking on Userland.
//
// Public visitors browse lessons, request a time, and see a confirmation.
// The studio owner reviews requests, confirms or declines them, edits lessons,
// and reads recent activity under /studio.
//
// Data lives in two managed collections declared in manifest.userland.json:
// `services` (the lessons on offer) and `bookings` (lesson requests).
// Demo-only behavior lives in demo.js. Every line in this file that exists only
// for the public demo ends with `// demo`; deleting those lines and demo.js
// removes demo mode (see "Demo mode" in README.md).

import * as demo from "./demo.js"; // demo
import { STUDIO_HOURS, openDays, slotsForDay } from "./schedule.js";
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
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const LESSON_LENGTHS = [20, 30, 45, 60, 90];
const HOLDS_TIME = new Set(["new", "confirmed"]);

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * `demoMode` is "auto" in production: demo mode turns on only at the demo
 * address (see DEMO_HOSTS in demo.js). Tests pass true or false.
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

  if (method === "POST" && !sameOrigin(request, url)) {
    return html(rc, views.messagePage({ title: "Request blocked", text: "This form must be sent from the studio's own pages.", chrome: rc.chrome }), { status: 403 });
  }

  if (path === "/" && method === "GET") return await showHome(rc);
  if (path === "/book" && method === "GET") return await showBookingForm(rc);
  if (path === "/book" && method === "POST") return await submitBooking(rc);
  if (path === "/booked" && method === "GET") return await showConfirmation(rc);

  if (path === "/studio" || path.startsWith("/studio/")) {
    const gate = await requireOwner(rc);
    if (gate.response) return gate.response;
    rc.user = gate.user;
    if (path === "/studio" && method === "GET") return await showInbox(rc);
    const statusMatch = path.match(/^\/studio\/bookings\/([^/]+)\/status$/u);
    if (statusMatch && method === "POST") return await updateBookingStatus(rc, decodeURIComponent(statusMatch[1]));
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
 * `demo_key: ""`. In demo mode a visitor's own records carry their key instead,
 * and the scope is null until they save something (see demo.js).
 */
function scopeOf(rc) {
  if (rc.demoMode) return rc.key; // demo
  return "";
}

/** True when a stored row belongs to this request's scope. */
function inScope(rc, row) {
  return (row.demo_key ?? "") === scopeOf(rc);
}

/** Fields saved on every new row: the studio's scope, plus an expiry time for demo visitors. */
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
 * a friendly redirect rather than an error. In the public demo anyone can
 * explore the owner side.
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

/** Rejects form posts sent from other sites. Requests without an Origin header (older browsers, scripts) are allowed. */
function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data access

async function listAll(collection, query, max = 500) {
  const rows = [];
  let cursor;
  do {
    const page = await collection.list({ ...query, limit: 100, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor && rows.length < max);
  return rows;
}

async function loadServices(rc, { includeHidden = false } = {}) {
  const scope = scopeOf(rc);
  let services = scope === null ? [] : await listAll(rc.ctx.data.collection("services"), { where: { demo_key: scope }, order_by: [{ field: "sort_order", direction: "asc" }] });
  if (rc.demoMode) services = demo.visitorServices(services, STARTER_SERVICES); // demo
  return includeHidden ? services : services.filter((service) => service.active);
}

async function loadBookings(rc) {
  const scope = scopeOf(rc);
  const rows = scope === null ? [] : await listAll(rc.ctx.data.collection("bookings"), { where: { demo_key: scope }, order_by: [{ field: "starts_at", direction: "asc" }] });
  return inStartOrder(rc, rows);
}

/** Bookings sorted by start time. In the demo, the made-up samples are included (see demo.js). */
function inStartOrder(rc, rows) {
  let bookings = [...rows];
  if (rc.demoMode) bookings = demo.visitorBookings(rows, STARTER_SERVICES, rc.now); // demo
  return bookings.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

function newRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `WH-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
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

function bookingDays(bookings, service, now) {
  const busy = bookings.filter((booking) => HOLDS_TIME.has(booking.status));
  const earliest = now.getTime() + STUDIO_HOURS.minNoticeHours * 60 * 60 * 1000;
  return openDays(now)
    .map((date) => {
      const slots = service ? slotsForDay(date, service.duration_minutes, busy, now) : [];
      return { date, slots, open: slots.some((slot) => slot.available) };
    })
    .filter((day) => day.slots.some((slot) => Date.parse(slot.starts_at) >= earliest)); // Skip days inside the notice period.
}

async function renderBookingForm(rc, { serviceId, date, form = {}, errors = {}, status = 200 }) {
  const [services, bookings] = await Promise.all([loadServices(rc), loadBookings(rc)]);
  const selected = services.find((service) => service.id === serviceId) ?? services[0] ?? null;
  const days = bookingDays(bookings, selected, rc.now);
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
  const demoCleanup = rc.demoMode ? demo.sweepDemoData(rc.ctx.data, rc.now) : null; // demo
  const scope = scopeOf(rc);

  // Check the time again right before saving, inside a data transaction, so a
  // time that was just taken is not handed out twice.
  const result = await rc.ctx.data.transaction(async (tx) => {
    const bookings = tx.collection("bookings");
    const existing = inStartOrder(rc, await listAll(bookings, { where: { demo_key: scope }, order_by: [{ field: "starts_at", direction: "asc" }] }));
    const busy = existing.filter((booking) => HOLDS_TIME.has(booking.status));
    const slot = slotsForDay(form.date, service.duration_minutes, busy, rc.now).find((item) => item.time === form.time);
    if (!openDays(rc.now).includes(form.date) || !slot || !slot.available) return { ok: false };
    const createdAt = rc.now.toISOString();
    const booking = await bookings.create({
      ref: newRef(),
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
    });
    return { ok: true, booking };
  });
  await demoCleanup; // demo

  if (!result.ok) {
    return await renderBookingForm(rc, {
      serviceId: service.id,
      date: form.date,
      form: { ...form, time: "" },
      errors: { time: "Sorry, that time was just taken. Please pick another." },
      status: 409
    });
  }

  // Log ids only. Contact details stay in managed data, not in the activity log.
  await rc.ctx.log.info("booking requested", { booking_id: result.booking.id, ref: result.booking.ref, service_id: service.id, starts_at: result.booking.starts_at, demo: rc.demoMode });
  return redirect(rc.chrome.link(`/booked?ref=${encodeURIComponent(result.booking.ref)}`));
}

async function showConfirmation(rc) {
  const ref = clean(rc.url.searchParams.get("ref"), 20);
  let booking = null;
  if (ref && scopeOf(rc) !== null) {
    const page = await rc.ctx.data.collection("bookings").list({ where: { ref }, limit: 1 });
    booking = page.rows.find((row) => inScope(rc, row)) ?? null;
  }
  if (!booking) {
    return html(rc, views.messagePage({ title: "We couldn't find that request", text: "The link may be incomplete. If you sent a request, it's safe with us and you'll hear back soon.", chrome: rc.chrome }), { status: 404 });
  }
  return html(rc, views.confirmationPage({ booking, chrome: rc.chrome }), { title: "Request received" });
}

// ---------------------------------------------------------------------------
// Studio pages (owner only)

async function showInbox(rc) {
  const bookings = await loadBookings(rc);
  let isSample = () => false;
  if (rc.demoMode) isSample = demo.isSample; // demo
  const tab = views.INBOX_TABS.find((item) => item.key === rc.url.searchParams.get("show")) ?? views.INBOX_TABS[0];
  const counts = Object.fromEntries(views.INBOX_TABS.map((item) => [item.key, bookings.filter((booking) => item.statuses.includes(booking.status)).length]));
  counts.upcoming = bookings.filter((booking) => booking.status === "confirmed" && Date.parse(booking.starts_at) > rc.now.getTime()).length;
  const shown = bookings.filter((booking) => tab.statuses.includes(booking.status));
  if (tab.key === "all" || tab.key === "closed") shown.reverse();
  const body = views.inboxPage({
    bookings: shown,
    tab,
    counts,
    transitions: TRANSITIONS,
    updatedId: rc.url.searchParams.get("updated"),
    chrome: rc.chrome,
    isSample,
    now: rc.now
  });
  return html(rc, body, { title: "Booking requests", area: "studio", current: "requests" });
}

async function updateBookingStatus(rc, bookingId) {
  const input = (await readForm(rc.request)) ?? {};
  const next = String(input.status ?? "");
  const show = views.INBOX_TABS.some((item) => item.key === input.show) ? input.show : "new";

  let id = bookingId;
  if (rc.demoMode) id = (await demo.prepareChange(rc, "bookings", STARTER_SERVICES, newRef)).get(bookingId)?.id ?? bookingId; // demo
  const collection = rc.ctx.data.collection("bookings");
  const booking = await collection.get(id);
  if (!booking || !inScope(rc, booking)) {
    return html(rc, views.messagePage({ title: "Booking not found", text: "It may have been removed.", chrome: rc.chrome, linkHref: "/studio", linkLabel: "Back to requests" }), { status: 404, area: "studio" });
  }
  if (!(TRANSITIONS[booking.status] ?? []).includes(next)) {
    return redirect(rc.chrome.link(`/studio?show=${show}#booking-${id}`));
  }
  const history = [...(Array.isArray(booking.history) ? booking.history : []), { at: rc.now.toISOString(), status: next, by: rc.user?.email ?? "owner" }];
  await collection.update(id, { status: next, history });
  await rc.ctx.log.info("booking status changed", { booking_id: id, from: booking.status, to: next, demo: rc.demoMode });
  return redirect(rc.chrome.link(`/studio?show=${show}&updated=${encodeURIComponent(id)}#booking-${id}`));
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

async function showActivity(rc) {
  const bookings = await loadBookings(rc);
  const entries = bookings
    .flatMap((booking) => (Array.isArray(booking.history) ? booking.history : []).map((entry) => ({ entry, booking })))
    .sort((a, b) => String(b.entry.at).localeCompare(String(a.entry.at)))
    .slice(0, 40);
  return html(rc, views.activityPage({ entries, chrome: rc.chrome, now: rc.now }), { title: "Activity", area: "studio", current: "activity" });
}

// ---------------------------------------------------------------------------
// Responses

function html(rc, body, { status = 200, title, area = "public", current = "", description = "" } = {}) {
  const page = views.layout({ title, description, body, chrome: rc.chrome, area, current, user: rc.user });
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

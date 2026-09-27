import { scheduledSlots } from "./schedule.js";

// Anyone can book, so these limits keep one person with a script from taking
// every slot or filling the app's data quota. Apps cannot see a visitor's IP
// address, so the per-person limit goes by email and the other is app-wide.
const LIMITS = {
  name: 120,
  email: 254,
  bodyBytes: 4000,
  bookingsPerEmailPerDay: 2,
  bookingsPerHour: 20,
  // Past slots nobody booked are deleted, a few per request.
  sweepPerRequest: 10
};
const HOUR = 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

// Bookings may only be made from this app's page. There is no sign-in here,
// but without the check any other site could make its visitors' browsers
// book slots. Browsers send Origin on every POST (a sandboxed page sends
// "null", which is rejected too). curl and other non-browser clients send
// neither header.
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// Reads a JSON object body, or returns the error response to send.
async function readJson(request) {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return { response: json({ error: "json_required" }, { status: 415 }) };
  }
  const text = await request.text();
  if (text.length > LIMITS.bodyBytes) {
    return { response: json({ error: "body_too_large" }, { status: 413 }) };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: json({ error: "invalid_json" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: json({ error: "invalid_json" }, { status: 400 }) };
  }
  return { body };
}

function publicSlot(slot) {
  // Public list: never include who booked a slot.
  return { id: slot.id, title: slot.title, starts_at: slot.starts_at, status: slot.status };
}

function slotKey(slot) {
  return `${slot.starts_at}|${slot.title}`;
}

// Reads pages until `keepGoing` is false for a row or there are no more pages.
async function readPages(collection, query, keepGoing = () => true) {
  const rows = [];
  let cursor;
  do {
    const page = await collection.list({ ...query, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) {
      if (!keepGoing(row)) return rows;
      rows.push(row);
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

// Lists every open slot that hasn't started, soonest first. On the way it
// adds slots from server/schedule.js that aren't stored yet, and deletes a
// few past slots that nobody booked. `where` and `order_by` fields must be
// indexed: by_status covers status and starts_at.
async function listSlots(ctx) {
  const now = Date.now();
  const slots = ctx.data.collection("slots");
  const available = await readPages(slots, { where: { status: "available" }, order_by: [{ field: "starts_at", direction: "asc" }] });
  // Booked slots, latest first, stopping at the first one in the past.
  const upcomingBooked = await readPages(
    slots,
    { where: { status: "booked" }, order_by: [{ field: "starts_at", direction: "desc" }] },
    (slot) => Date.parse(slot.starts_at) > now
  );
  const known = new Set([...available, ...upcomingBooked].map(slotKey));

  const added = [];
  for (const entry of scheduledSlots(new Date(now))) {
    const startsAt = new Date(entry?.starts_at ?? "");
    const title = String(entry?.title ?? "").trim().slice(0, 200);
    if (!title || Number.isNaN(startsAt.getTime())) {
      await ctx.log.warn("scheduled slot skipped", { reason: "invalid_entry" });
      continue;
    }
    const slot = { title, starts_at: startsAt.toISOString() };
    if (startsAt.getTime() <= now || known.has(slotKey(slot))) continue;
    try {
      added.push(await slots.create({ ...slot, status: "available", booked_by: "" }));
    } catch (error) {
      // The by_time unique index: another request added it a moment ago.
      if (error?.code !== "unique_conflict") throw error;
    }
    known.add(slotKey(slot));
  }

  const past = available.filter((slot) => Date.parse(slot.starts_at) <= now);
  for (const slot of past.slice(0, LIMITS.sweepPerRequest)) {
    await slots.delete(slot.id);
  }

  const open = [...available.filter((slot) => Date.parse(slot.starts_at) > now), ...added].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return json({ slots: open.map(publicSlot) });
}

function validateBooking(input) {
  const slotId = typeof input.slot_id === "string" ? input.slot_id : "";
  const name = String(input.name ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(slotId)) return { error: "slot_id_required" };
  if (!name) return { error: "name_required" };
  if (name.length > LIMITS.name) return { error: "name_too_long", max_length: LIMITS.name };
  if (email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) return { error: "invalid_email" };
  return { booking: { slotId, name, email } };
}

// Returns an error response when this booking would go over a limit. Both
// checks read before the booking is written, so simultaneous requests can go
// slightly over; they are a brake, not a lock. The unique index on slot_id is
// what guarantees one booking per slot.
async function overLimit(bookings, email, now) {
  const recent = (rows, ms) => rows.filter((row) => now - Date.parse(row.created_at) < ms).length;
  const sameEmail = await bookings.list({ where: { email }, limit: 100 });
  if (recent(sameEmail.rows, 24 * HOUR) >= LIMITS.bookingsPerEmailPerDay) {
    return json({ error: "too_many_bookings", max_per_day: LIMITS.bookingsPerEmailPerDay }, { status: 429 });
  }
  // Without `order_by`, rows come back most recently updated first, and
  // bookings are never edited, so this is the newest 100.
  const latest = await bookings.list({ limit: 100 });
  if (recent(latest.rows, HOUR) >= LIMITS.bookingsPerHour) {
    return json({ error: "busy", retry_after_minutes: 60 }, { status: 429, headers: { "retry-after": "3600" } });
  }
  return null;
}

// If a booking exists but its slot still shows as open (a request stopped
// between the two writes), mark the slot booked so the list is right again.
async function repairSlot(slots, bookings, slotId) {
  const existing = await bookings.list({ where: { slot_id: slotId }, limit: 1 });
  const slot = await slots.get(slotId);
  if (existing.rows[0] && slot?.status === "available") {
    await slots.update(slotId, { status: "booked", booked_by: existing.rows[0].id });
  }
}

async function createBooking(request, ctx) {
  const { body: input, response } = await readJson(request);
  if (response) return response;

  // Honeypot: the page hides the "website" field, so only bots fill it in.
  if (input.website) {
    await ctx.log.warn("booking ignored", { reason: "honeypot" });
    return json({ received: true }, { status: 202 });
  }

  const { booking: form, ...invalid } = validateBooking(input);
  if (!form) return json(invalid, { status: 400 });

  const now = Date.now();
  // The transaction only groups these calls. In deployed apps it neither
  // rolls back a write when a later step fails nor stops two requests from
  // running at once, so the code below handles both itself.
  const result = await ctx.data.transaction(async (tx) => {
    const slots = tx.collection("slots");
    const bookings = tx.collection("bookings");
    const slot = await slots.get(form.slotId);
    if (!slot || slot.status !== "available" || Date.parse(slot.starts_at) <= now) {
      return { response: json({ error: "slot_unavailable" }, { status: 409 }) };
    }
    const limited = await overLimit(bookings, form.email, now);
    if (limited) return { response: limited };

    let booking;
    try {
      // The by_slot unique index allows one booking per slot_id. When two
      // people book the same slot at once, the second create throws
      // unique_conflict, even though both saw the slot as open.
      booking = await bookings.create({ slot_id: form.slotId, name: form.name, email: form.email, status: "confirmed" });
    } catch (error) {
      if (error?.code !== "unique_conflict") throw error;
      await repairSlot(slots, bookings, form.slotId);
      return { response: json({ error: "slot_unavailable" }, { status: 409 }) };
    }

    try {
      const updated = await slots.update(form.slotId, { status: "booked", booked_by: booking.id });
      return { booking, slot: updated };
    } catch (error) {
      // Undo the booking by hand so the slot can be booked again.
      await bookings.delete(booking.id);
      await ctx.log.error("booking undone", { slot_id: form.slotId, code: String(error?.code ?? "unknown") });
      return { response: json({ error: "booking_failed" }, { status: 503 }) };
    }
  });
  if (result.response) return result.response;

  // Log ids only; names and emails stay in the server-only bookings collection.
  await ctx.log.info("slot booked", { slot_id: form.slotId, booking_id: result.booking.id });
  return json(
    {
      booking: { id: result.booking.id, slot_id: form.slotId, status: result.booking.status },
      slot: publicSlot(result.slot)
    },
    { status: 201 }
  );
}

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const app = {
  async fetch(request, ctx) {
    if (request.method === "HEAD") return await answerHead(request, ctx, app.fetch);
    const url = new URL(request.url);
    if (url.pathname === "/api/slots" && request.method === "GET") {
      return await listSlots(ctx);
    }
    if (url.pathname === "/api/bookings" && request.method === "POST") {
      if (!isSameOrigin(request, url)) return json({ error: "cross_origin_request" }, { status: 403 });
      return await createBooking(request, ctx);
    }
    return new Response("Not found", { status: 404 });
  }
};

export default app;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

async function listSlots(ctx) {
  // `where` and `order_by` fields must be indexed; see the by_status index.
  const slots = await ctx.data.collection("slots").list({
    where: { status: "available" },
    order_by: [{ field: "starts_at", direction: "asc" }],
    limit: 50
  });
  // Public list: never include who booked a slot.
  return json({ slots: slots.rows.map((slot) => ({ id: slot.id, title: slot.title, starts_at: slot.starts_at, status: slot.status })) });
}

// Demo slots start tomorrow and the day after at 16:00 UTC.
function upcomingSlotTime(daysFromNow) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(16, 0, 0, 0);
  return date.toISOString();
}

async function seedSlots(ctx) {
  const collection = ctx.data.collection("slots");
  const existing = await collection.list({ limit: 1 });
  if (existing.rows.length > 0) {
    return json({ seeded: false });
  }
  const seeded = [
    await collection.create({ title: "Intro call", starts_at: upcomingSlotTime(1), status: "available", booked_by: "" }),
    await collection.create({ title: "Planning session", starts_at: upcomingSlotTime(2), status: "available", booked_by: "" })
  ];
  await ctx.log.info("booking slots seeded", { count: seeded.length });
  return json({ seeded: true, slots: seeded.map((slot) => ({ id: slot.id, title: slot.title, starts_at: slot.starts_at, status: slot.status })) }, { status: 201 });
}

async function createBooking(request, ctx) {
  const input = await request.json();
  const slotId = String(input.slot_id ?? "");
  const name = String(input.name ?? "");
  const email = String(input.email ?? "");

  if (!slotId || !name || !email) {
    return json({ error: "slot_id, name, and email are required" }, { status: 400 });
  }

  const result = await ctx.data.transaction(async (tx) => {
    const slots = tx.collection("slots");
    const bookings = tx.collection("bookings");
    const slot = await slots.get(slotId);
    if (!slot || slot.status !== "available") {
      return { ok: false, status: 409, error: "slot_unavailable" };
    }
    const booking = await bookings.create({
      slot_id: slotId,
      name,
      email,
      status: "confirmed"
    });
    const updatedSlot = await slots.update(slotId, {
      status: "booked",
      booked_by: booking.id
    });
    return { ok: true, booking, slot: updatedSlot };
  });

  if (!result.ok) {
    return json({ error: result.error }, { status: result.status });
  }

  await ctx.log.info("slot booked", { slot_id: slotId, booking_id: result.booking.id });
  return json(
    {
      booking: { id: result.booking.id, slot_id: slotId, status: result.booking.status },
      slot: { id: result.slot.id, title: result.slot.title, starts_at: result.slot.starts_at, status: result.slot.status }
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
    if (url.pathname === "/api/seed" && request.method === "POST") {
      return await seedSlots(ctx);
    }
    if (url.pathname === "/api/bookings" && request.method === "POST") {
      return await createBooking(request, ctx);
    }
    return new Response("Not found", { status: 404 });
  }
};

export default app;

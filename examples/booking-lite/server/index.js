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
  const slots = await ctx.data.collection("slots").list({
    where: { status: "available" },
    order_by: [{ field: "starts_at", direction: "asc" }]
  });
  return json({ slots: slots.rows });
}

async function seedSlots(ctx) {
  const slots = await ctx.data.collection("slots").list({});
  if (slots.rows.length > 0) {
    return json({ seeded: false, slots: slots.rows });
  }
  const collection = ctx.data.collection("slots");
  const seeded = [
    await collection.create({ title: "Intro call", starts_at: "2026-06-01T16:00:00.000Z", status: "available", booked_by: "" }),
    await collection.create({ title: "Planning session", starts_at: "2026-06-02T16:00:00.000Z", status: "available", booked_by: "" })
  ];
  await ctx.log.info("booking slots seeded", { count: seeded.length });
  return json({ seeded: true, slots: seeded }, { status: 201 });
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
  return json({ booking: result.booking, slot: result.slot }, { status: 201 });
}

export default {
  async fetch(request, ctx) {
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


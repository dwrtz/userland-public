import path from "node:path";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

async function seededRuntime() {
  const runtime = createFakeRuntime(manifest);
  const seed = await app.fetch(new Request("https://example.test/api/seed", { method: "POST" }), runtime.ctx);
  expect(seed.status).toBe(201);
  const slots = await app.fetch(new Request("https://example.test/api/slots"), runtime.ctx);
  const body = await slots.json();
  return { runtime, slots: body.slots as Array<{ id: string; starts_at: string }> };
}

async function book(ctx: unknown, slotId: string) {
  return await app.fetch(
    new Request("https://example.test/api/bookings", {
      method: "POST",
      body: JSON.stringify({ slot_id: slotId, name: "Ada", email: "ada@example.test" })
    }),
    ctx
  );
}

it("seeds upcoming slots once, sorted by start time", async () => {
  const { runtime, slots } = await seededRuntime();
  expect(slots).toHaveLength(2);
  expect(Date.parse(slots[0]!.starts_at)).toBeGreaterThan(Date.now());
  expect(slots[0]!.starts_at < slots[1]!.starts_at).toBe(true);

  const again = await app.fetch(new Request("https://example.test/api/seed", { method: "POST" }), runtime.ctx);
  expect(await again.json()).toEqual({ seeded: false });
});

it("claims a slot only once inside a transaction", async () => {
  const { runtime, slots } = await seededRuntime();
  const slotId = slots[0]!.id;

  const first = await book(runtime.ctx, slotId);
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({
    booking: { slot_id: slotId, status: "confirmed" },
    slot: { id: slotId, status: "booked" }
  });

  const second = await book(runtime.ctx, slotId);
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "slot_unavailable" });

  const available = await app.fetch(new Request("https://example.test/api/slots"), runtime.ctx);
  const body = await available.json();
  expect(body.slots.map((slot: { id: string }) => slot.id)).not.toContain(slotId);
  expect(JSON.stringify(body)).not.toContain("ada@example.test");
});

it("rejects incomplete booking requests", async () => {
  const { runtime } = await seededRuntime();
  const response = await app.fetch(new Request("https://example.test/api/bookings", { method: "POST", body: JSON.stringify({ slot_id: "x" }) }), runtime.ctx);
  expect(response.status).toBe(400);
});

it("answers HEAD on the slot list like GET, without a body", async () => {
  const { runtime } = await seededRuntime();
  expect((await expectHeadLikeGet(app, runtime.ctx, "https://example.test/api/slots")).status).toBe(200);
});

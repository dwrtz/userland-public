import path from "node:path";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { scheduledSlots } from "../server/schedule.js";
import { deployedRuntime } from "./deployed-runtime.js";

// These tests add their own slots, so they keep passing when server/schedule.js
// lists your real slots instead of the samples.
const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));
const APP = "https://example.test";
const DAY = 24 * 60 * 60 * 1000;
type Runtime = ReturnType<typeof createFakeRuntime>;

// A runtime that behaves like a deployed app (see deployed-runtime.ts).
function runtimeWithSlots() {
  const runtime = deployedRuntime(createFakeRuntime(manifest));
  const add = (title: string, startsAt: number) =>
    runtime.ctx.data.collection("slots").create({ title, starts_at: new Date(startsAt).toISOString(), status: "available", booked_by: "" });
  return { runtime, add };
}

async function futureSlots(runtime: Runtime, count: number) {
  const slots = [];
  for (let index = 0; index < count; index += 1) {
    slots.push(await runtime.ctx.data.collection("slots").create({ title: `Test slot ${index}`, starts_at: new Date(Date.now() + (index + 3) * DAY).toISOString(), status: "available", booked_by: "" }));
  }
  return slots;
}

function book(runtime: Runtime, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(
    new Request(`${APP}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    runtime.ctx
  );
}

async function openSlotIds(runtime: Runtime) {
  const response = await app.fetch(new Request(`${APP}/api/slots`), runtime.ctx);
  expect(response.status).toBe(200);
  const body = await response.json();
  return { ids: body.slots.map((slot: { id: string }) => slot.id) as string[], body };
}

it("books an open slot once and hides who booked it", async () => {
  const { runtime } = runtimeWithSlots();
  const [slot] = await futureSlots(runtime, 1);

  const first = await book(runtime, { slot_id: slot!.id, name: "Ada", email: "ada@example.test" });
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({ booking: { slot_id: slot!.id, status: "confirmed" }, slot: { id: slot!.id, status: "booked" } });

  const second = await book(runtime, { slot_id: slot!.id, name: "Bob", email: "bob@example.test" });
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "slot_unavailable" });

  const { ids, body } = await openSlotIds(runtime);
  expect(ids).not.toContain(slot!.id);
  expect(JSON.stringify(body)).not.toContain("ada@example.test");
});

it("gives a slot to exactly one of several people booking it at the same moment", async () => {
  const { runtime } = runtimeWithSlots();
  const [slot] = await futureSlots(runtime, 1);
  // Count the creates the unique index turned away: all five requests see the
  // slot as open, so it is the index, not the availability check, that decides.
  const collection = runtime.ctx.data.collection;
  let conflicts = 0;
  runtime.ctx.data.collection = ((name: string) => {
    const inner = collection(name);
    return {
      ...inner,
      async create(input: Record<string, unknown>) {
        try {
          return await inner.create(input);
        } catch (error) {
          if ((error as { code?: string }).code === "unique_conflict") conflicts += 1;
          throw error;
        }
      }
    };
  }) as typeof collection;
  const responses: Response[] = await Promise.all(
    ["a", "b", "c", "d", "e"].map((who) => book(runtime, { slot_id: slot!.id, name: who, email: `${who}@example.test` }))
  );
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409]);
  for (const response of responses.filter((item) => item.status === 409)) {
    expect(await response.json()).toEqual({ error: "slot_unavailable" });
  }
  expect(conflicts).toBe(4);
  expect(runtime.state.rows.get("bookings")).toHaveLength(1);
  const stored = runtime.state.rows.get("slots")!.find((row) => row.id === slot!.id)!;
  expect(stored.status).toBe("booked");
  expect(stored.booked_by).toBe(runtime.state.rows.get("bookings")![0]!.id);
});

it("undoes the booking when marking the slot booked fails, so the slot stays bookable", async () => {
  const { runtime } = runtimeWithSlots();
  const [slot] = await futureSlots(runtime, 1);
  const collection = runtime.ctx.data.collection;
  let failOnce = true;
  runtime.ctx.data.collection = ((name: string) => {
    const inner = collection(name);
    if (name !== "slots") return inner;
    return {
      ...inner,
      async update(id: string, patch: Record<string, unknown>) {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("storage unavailable"), { code: "storage_error", status: 500 });
        }
        return await inner.update(id, patch);
      }
    };
  }) as typeof collection;

  const failed = await book(runtime, { slot_id: slot!.id, name: "Ada", email: "ada@example.test" });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "booking_failed" });
  expect(runtime.state.rows.get("bookings")).toHaveLength(0);
  expect((await openSlotIds(runtime)).ids).toContain(slot!.id);

  expect((await book(runtime, { slot_id: slot!.id, name: "Ada", email: "ada@example.test" })).status).toBe(201);
});

it("fixes a slot left open by a booking that stopped halfway", async () => {
  const { runtime } = runtimeWithSlots();
  const [slot] = await futureSlots(runtime, 1);
  // A booking row exists but the slot was never marked booked.
  await runtime.ctx.data.collection("bookings").create({ slot_id: slot!.id, name: "Ada", email: "ada@example.test", status: "confirmed" });

  expect((await book(runtime, { slot_id: slot!.id, name: "Bob", email: "bob@example.test" })).status).toBe(409);
  expect((await openSlotIds(runtime)).ids).not.toContain(slot!.id);
});

it("checks names and emails, and answers 400, 403, or 415 for requests it cannot use", async () => {
  const { runtime } = runtimeWithSlots();
  const [slot] = await futureSlots(runtime, 1);
  const cases: Array<[unknown, string]> = [
    [{ slot_id: slot!.id, email: "ada@example.test" }, "name_required"],
    [{ slot_id: slot!.id, name: "  ", email: "ada@example.test" }, "name_required"],
    [{ slot_id: slot!.id, name: "A".repeat(121), email: "ada@example.test" }, "name_too_long"],
    [{ slot_id: slot!.id, name: "Ada", email: "not-an-email" }, "invalid_email"],
    [{ slot_id: slot!.id, name: "Ada", email: `${"a".repeat(250)}@example.test` }, "invalid_email"],
    [{ slot_id: "../x", name: "Ada", email: "ada@example.test" }, "slot_id_required"],
    [{ name: "Ada", email: "ada@example.test" }, "slot_id_required"]
  ];
  for (const [body, error] of cases) {
    const response = await book(runtime, body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(error);
  }
  for (const body of ["{nope", "null", "[]"]) {
    expect((await book(runtime, body)).status).toBe(400);
  }
  expect((await book(runtime, JSON.stringify({ slot_id: slot!.id, name: "Ada", email: "ada@example.test" }), { "content-type": "text/plain" })).status).toBe(415);
  expect((await book(runtime, { slot_id: slot!.id, name: "Ada", email: "ada@example.test" }, { origin: "https://other.apps.userland.fun" })).status).toBe(403);
  expect((await book(runtime, { slot_id: slot!.id, name: "Ada", email: "ada@example.test" }, { origin: "null" })).status).toBe(403);
  expect(runtime.state.rows.get("bookings")).toHaveLength(0);
});

it("quietly drops bookings that fill in the hidden honeypot field", async () => {
  const { runtime } = runtimeWithSlots();
  const [slot] = await futureSlots(runtime, 1);
  const response = await book(runtime, { slot_id: slot!.id, name: "Bot", email: "bot@example.test", website: "https://spam.test" });
  expect(response.status).toBe(202);
  expect(runtime.state.rows.get("bookings")).toHaveLength(0);
  expect((await openSlotIds(runtime)).ids).toContain(slot!.id);
});

it("does not list or book slots that have already started, and clears old unbooked ones", async () => {
  const { runtime, add } = runtimeWithSlots();
  const past: Array<{ id: string }> = [];
  for (let index = 0; index < 12; index += 1) past.push(await add(`Past ${index}`, Date.now() - (index + 1) * DAY));
  const [future] = await futureSlots(runtime, 1);

  expect((await book(runtime, { slot_id: past[0]!.id, name: "Ada", email: "ada@example.test" })).status).toBe(409);

  const { ids } = await openSlotIds(runtime);
  expect(ids).toContain(future!.id);
  expect(ids.some((id) => past.some((slot) => slot.id === id))).toBe(false);
  // Ten are deleted per request; the next request clears the rest.
  expect(runtime.state.rows.get("slots")!.filter((row) => String(row.title).startsWith("Past"))).toHaveLength(2);
  await openSlotIds(runtime);
  expect(runtime.state.rows.get("slots")!.filter((row) => String(row.title).startsWith("Past"))).toHaveLength(0);
});

it("limits bookings per email per day, ignoring capital letters", async () => {
  const { runtime } = runtimeWithSlots();
  const slots = await futureSlots(runtime, 3);
  expect((await book(runtime, { slot_id: slots[0]!.id, name: "Ada", email: "ada@example.test" })).status).toBe(201);
  expect((await book(runtime, { slot_id: slots[1]!.id, name: "Ada", email: "ADA@example.test" })).status).toBe(201);
  const third = await book(runtime, { slot_id: slots[2]!.id, name: "Ada", email: "ada@Example.test" });
  expect(third.status).toBe(429);
  expect(await third.json()).toEqual({ error: "too_many_bookings", max_per_day: 2 });

  for (const row of runtime.state.rows.get("bookings")!) row.created_at = new Date(Date.now() - 2 * DAY).toISOString();
  expect((await book(runtime, { slot_id: slots[2]!.id, name: "Ada", email: "ada@example.test" })).status).toBe(201);
});

it("limits bookings across the whole app to 20 an hour", async () => {
  const { runtime } = runtimeWithSlots();
  const slots = await futureSlots(runtime, 21);
  for (let index = 0; index < 20; index += 1) {
    expect((await book(runtime, { slot_id: slots[index]!.id, name: "Guest", email: `guest${index}@example.test` })).status).toBe(201);
  }
  const blocked = await book(runtime, { slot_id: slots[20]!.id, name: "Guest", email: "late@example.test" });
  expect(blocked.status).toBe(429);
  expect((await blocked.json()).error).toBe("busy");
});

it("lists every open slot, past the first page of 100", async () => {
  const { runtime } = runtimeWithSlots();
  const slots = await futureSlots(runtime, 130);
  const { ids, body } = await openSlotIds(runtime);
  for (const slot of slots) expect(ids).toContain(slot.id);
  const times = body.slots.map((slot: { starts_at: string }) => slot.starts_at);
  expect(times).toEqual([...times].sort());
});

it("adds each slot from server/schedule.js once, even when the list is opened by several people at once", async () => {
  const { runtime } = runtimeWithSlots();
  const expected = (scheduledSlots(new Date()) as Array<{ title: string; starts_at: string }>).filter((slot) => Date.parse(slot.starts_at) > Date.now());
  await Promise.all([1, 2, 3, 4].map(() => app.fetch(new Request(`${APP}/api/slots`), runtime.ctx)));
  await openSlotIds(runtime);
  expect(runtime.state.rows.get("slots")).toHaveLength(expected.length);

  // A booked scheduled slot is not added again.
  const [first] = runtime.state.rows.get("slots")!;
  if (first) {
    expect((await book(runtime, { slot_id: first.id, name: "Ada", email: "ada@example.test" })).status).toBe(201);
    const { ids } = await openSlotIds(runtime);
    expect(ids).not.toContain(first.id);
    expect(runtime.state.rows.get("slots")).toHaveLength(expected.length);
  }
});

it("answers HEAD on the slot list like GET, without a body", async () => {
  const { runtime } = runtimeWithSlots();
  await futureSlots(runtime, 1);
  expect((await expectHeadLikeGet(app, runtime.ctx, `${APP}/api/slots`)).status).toBe(200);
});

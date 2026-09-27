// Tests for the sample slots in server/schedule.js. When you replace them with
// your own slots, delete this file (AGENT.md, "Use your own slots").
import path from "node:path";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

async function openSlots(ctx: unknown) {
  const response = await app.fetch(new Request("https://example.test/api/slots"), ctx);
  return (await response.json()).slots as Array<{ id: string; title: string; starts_at: string }>;
}

afterEach(() => {
  vi.useRealTimers();
});

it("offers an intro call tomorrow and a planning session the day after, at 16:00 UTC", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
  const runtime = createFakeRuntime(manifest);
  expect((await openSlots(runtime.ctx)).map((slot) => [slot.title, slot.starts_at])).toEqual([
    ["Intro call", "2026-10-02T16:00:00.000Z"],
    ["Planning session", "2026-10-03T16:00:00.000Z"]
  ]);
});

it("adds the next day's samples as days pass and clears the ones nobody booked", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
  const runtime = createFakeRuntime(manifest);
  await openSlots(runtime.ctx);

  vi.setSystemTime(new Date("2026-10-03T09:00:00.000Z"));
  expect((await openSlots(runtime.ctx)).map((slot) => slot.starts_at)).toEqual([
    "2026-10-03T16:00:00.000Z",
    "2026-10-04T16:00:00.000Z",
    "2026-10-05T16:00:00.000Z"
  ]);
  // The 2 October intro call had passed, so it was deleted.
  expect(runtime.state.rows.get("slots")!.map((row) => row.starts_at).sort()).toEqual([
    "2026-10-03T16:00:00.000Z",
    "2026-10-04T16:00:00.000Z",
    "2026-10-05T16:00:00.000Z"
  ]);
});

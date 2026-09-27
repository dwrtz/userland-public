import path from "node:path";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));
const HOUR = 60 * 60 * 1000;

function createNote(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

// Moves every stored note's creation time back by `ms`.
function age(runtime: ReturnType<typeof createFakeRuntime>, ms: number, count = Infinity) {
  for (const row of runtime.state.rows.get("notes")!.slice(0, count)) {
    row.created_at = new Date(Date.parse(row.created_at) - ms).toISOString();
  }
}

async function seedNotes(runtime: ReturnType<typeof createFakeRuntime>, count: number) {
  const notes = runtime.ctx.data.collection("notes");
  for (let index = 0; index < count; index += 1) {
    await notes.create({ title: `Note ${index}`, body: "", status: "open" });
  }
}

it("creates and lists notes", async () => {
  const runtime = createFakeRuntime(manifest);
  const create = await app.fetch(createNote({ title: "First", body: "Hello" }), runtime.ctx);
  expect(create.status).toBe(201);
  const { note } = await create.json();
  expect(runtime.state.logs).toContainEqual({ level: "info", message: "note created", metadata: { note_id: note.id } });

  await app.fetch(createNote({ title: "Second", body: "World" }), runtime.ctx);

  const list = await app.fetch(new Request("https://example.test/api/notes"), runtime.ctx);
  expect(list.status).toBe(200);
  const body = await list.json();
  expect(body.notes.map((row: { title: string }) => row.title)).toEqual(["Second", "First"]);
  expect(body.notes[1]).toMatchObject({ id: note.id, title: "First", body: "Hello", status: "open" });
  expect(body.cursor).toBeUndefined();
});

it("rejects notes without a title or over the length limits", async () => {
  const runtime = createFakeRuntime(manifest);
  expect((await app.fetch(createNote({ body: "No title" }), runtime.ctx)).status).toBe(400);
  expect((await app.fetch(createNote({ title: "x".repeat(201) }), runtime.ctx)).status).toBe(400);
  expect((await app.fetch(createNote({ title: "ok", body: "x".repeat(2001) }), runtime.ctx)).status).toBe(400);
  expect(runtime.state.rows.get("notes")).toHaveLength(0);
});

it("answers 400, 413, or 415 for bodies it cannot read, instead of failing", async () => {
  const runtime = createFakeRuntime(manifest);
  for (const body of ["{nope", "null", "[]"]) {
    const response = await app.fetch(createNote(body), runtime.ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  }
  expect((await app.fetch(createNote({ title: "t", body: "x".repeat(20_000) }), runtime.ctx)).status).toBe(413);
  expect((await app.fetch(createNote('{"title":"t"}', { "content-type": "text/plain" }), runtime.ctx)).status).toBe(415);
});

it("refuses notes posted from other sites", async () => {
  const runtime = createFakeRuntime(manifest);
  expect((await app.fetch(createNote({ title: "t" }, { origin: "https://other.apps.userland.fun" }), runtime.ctx)).status).toBe(403);
  expect((await app.fetch(createNote({ title: "t" }, { origin: "null" }), runtime.ctx)).status).toBe(403);
  expect((await app.fetch(createNote({ title: "t" }, { origin: "https://example.test" }), runtime.ctx)).status).toBe(201);
});

it("quietly drops posts that fill in the hidden honeypot field", async () => {
  const runtime = createFakeRuntime(manifest);
  const response = await app.fetch(createNote({ title: "Buy now", website: "https://spam.test" }), runtime.ctx);
  expect(response.status).toBe(202);
  expect(runtime.state.rows.get("notes")).toHaveLength(0);
  expect(runtime.state.logs).toContainEqual({ level: "warn", message: "note ignored", metadata: { reason: "honeypot" } });
});

it("limits how many notes the whole app takes per hour", async () => {
  const runtime = createFakeRuntime(manifest);
  for (let index = 0; index < 30; index += 1) {
    expect((await app.fetch(createNote({ title: `Note ${index}` }), runtime.ctx)).status).toBe(201);
  }
  const blocked = await app.fetch(createNote({ title: "One more" }), runtime.ctx);
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("3600");

  age(runtime, 2 * HOUR);
  expect((await app.fetch(createNote({ title: "Later" }), runtime.ctx)).status).toBe(201);
});

it("stops at 300 open notes and makes room by deleting notes older than 30 days", async () => {
  const runtime = createFakeRuntime(manifest);
  await seedNotes(runtime, 300);
  age(runtime, 2 * HOUR);

  const full = await app.fetch(createNote({ title: "Full" }), runtime.ctx);
  expect(full.status).toBe(503);
  expect(await full.json()).toEqual({ error: "board_full" });

  // The first 12 created are now past the 30 days; one post deletes at most 10.
  age(runtime, 31 * 24 * HOUR, 12);
  expect((await app.fetch(createNote({ title: "Room now" }), runtime.ctx)).status).toBe(201);
  expect(runtime.state.rows.get("notes")).toHaveLength(291);
  expect(runtime.state.logs).toContainEqual(expect.objectContaining({ message: "note created", metadata: expect.objectContaining({ expired_deleted: 10 }) }));
});

it("pages through every note instead of stopping at the first page", async () => {
  const runtime = createFakeRuntime(manifest);
  await seedNotes(runtime, 45);
  const titles: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const response = await app.fetch(new Request(`https://example.test/api/notes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`), runtime.ctx);
    const body = await response.json();
    titles.push(...body.notes.map((note: { title: string }) => note.title));
    cursor = body.cursor;
    pages += 1;
  } while (cursor);
  expect(pages).toBe(3);
  expect(new Set(titles).size).toBe(45);
  expect(titles[0]).toBe("Note 44");
  expect((await app.fetch(new Request("https://example.test/api/notes?cursor=%3Cx%3E"), runtime.ctx)).status).toBe(400);
});

it("answers HEAD on the note list like GET, without a body", async () => {
  const runtime = createFakeRuntime(manifest);
  await app.fetch(createNote({ title: "First", body: "Hello" }), runtime.ctx);
  expect((await expectHeadLikeGet(app, runtime.ctx, "https://example.test/api/notes")).status).toBe(200);
});

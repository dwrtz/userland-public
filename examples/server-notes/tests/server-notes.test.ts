import path from "node:path";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

function createNote(body: unknown) {
  return new Request("https://example.test/api/notes", { method: "POST", body: JSON.stringify(body) });
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
});

it("rejects notes without a title", async () => {
  const runtime = createFakeRuntime(manifest);
  const create = await app.fetch(createNote({ body: "No title" }), runtime.ctx);
  expect(create.status).toBe(400);
});

it("answers HEAD on the note list like GET, without a body", async () => {
  const runtime = createFakeRuntime(manifest);
  await app.fetch(createNote({ title: "First", body: "Hello" }), runtime.ctx);
  expect((await expectHeadLikeGet(app, runtime.ctx, "https://example.test/api/notes")).status).toBe(200);
});

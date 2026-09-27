import path from "node:path";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));
const admin = { id: "appusr_admin", app_user_id: "appusr_admin", email: "admin@example.test", roles: ["admin"] };

function post(pathname: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request(`https://example.test${pathname}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

it("rejects writes from visitors and non-admin app users with 401 and 403", async () => {
  const runtime = createFakeRuntime(manifest);
  expect((await app.fetch(post("/api/posts", { title: "Hi" }), runtime.ctx)).status).toBe(401);

  runtime.setUser({ ...admin, roles: [] });
  expect((await app.fetch(post("/api/posts", { title: "Hi" }), runtime.ctx)).status).toBe(403);
});

it("lets an admin create, publish, and list posts with indexed queries", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });

  const draft = await app.fetch(post("/api/posts", { title: "Draft", body: "Not yet" }), runtime.ctx);
  expect(draft.status).toBe(201);
  const draftBody = await draft.json();

  const published = await app.fetch(post("/api/posts", { title: "Hello", body: "World", status: "published" }), runtime.ctx);
  expect(published.status).toBe(201);

  const list = await app.fetch(new Request("https://example.test/api/posts"), runtime.ctx);
  expect(list.status).toBe(200);
  expect((await list.json()).posts.map((row: { title: string }) => row.title)).toEqual(["Hello"]);

  const publish = await app.fetch(post(`/api/posts/${draftBody.post.id}/publish`, {}), runtime.ctx);
  expect(publish.status).toBe(200);

  const page = await app.fetch(new Request(`https://example.test/posts/${draftBody.post.id}`), runtime.ctx);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<h1>Draft</h1>");
});

it("escapes post content on public pages", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  const created = await app.fetch(post("/api/posts", { title: "<script>x</script>", body: "b", status: "published" }), runtime.ctx);
  const { post: row } = await created.json();
  const page = await app.fetch(new Request(`https://example.test/posts/${row.id}`), runtime.ctx);
  expect(await page.text()).not.toContain("<script>x</script>");
});

it("uploads media only with an allowed content type", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  const upload = await app.fetch(post("/api/uploads", "hello", { "content-type": "text/plain", "x-filename": "hello.txt" }), runtime.ctx);
  expect(upload.status).toBe(201);
  await expect(app.fetch(post("/api/uploads", "<svg/>", { "content-type": "image/svg+xml" }), runtime.ctx)).rejects.toThrow(/not allowed/u);
});

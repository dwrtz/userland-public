import path from "node:path";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));
const admin = { id: "appusr_admin", app_user_id: "appusr_admin", email: "admin@example.test", roles: ["admin"] };
const APP = "https://example.test";

function post(pathname: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request(`${APP}${pathname}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function listAll(ctx: unknown, query = "") {
  const titles: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const params = new URLSearchParams(query);
    if (cursor) params.set("cursor", cursor);
    const response = await app.fetch(new Request(`${APP}/api/posts?${params}`), ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    titles.push(...body.posts.map((row: { title: string }) => row.title));
    cursor = body.cursor;
    pages += 1;
  } while (cursor);
  return { titles, pages };
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

  const list = await app.fetch(new Request(`${APP}/api/posts`), runtime.ctx);
  expect(list.status).toBe(200);
  expect((await list.json()).posts.map((row: { title: string }) => row.title)).toEqual(["Hello"]);

  const publish = await app.fetch(post(`/api/posts/${draftBody.post.id}/publish`, {}), runtime.ctx);
  expect(publish.status).toBe(200);

  const page = await app.fetch(new Request(`${APP}/posts/${draftBody.post.id}`), runtime.ctx);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<h1>Draft</h1>");
});

it("lists drafts only for admins, so the editor can publish them", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  await app.fetch(post("/api/posts", { title: "Draft one" }), runtime.ctx);
  await app.fetch(post("/api/posts", { title: "Live", status: "published" }), runtime.ctx);

  const drafts = await app.fetch(new Request(`${APP}/api/posts?status=draft`), runtime.ctx);
  expect(drafts.status).toBe(200);
  expect(drafts.headers.get("cache-control")).toBe("no-store");
  expect((await drafts.json()).posts).toEqual([expect.objectContaining({ title: "Draft one", status: "draft" })]);

  runtime.setUser(null);
  expect((await app.fetch(new Request(`${APP}/api/posts?status=draft`), runtime.ctx)).status).toBe(401);
  runtime.setUser({ ...admin, roles: [] });
  expect((await app.fetch(new Request(`${APP}/api/posts?status=draft`), runtime.ctx)).status).toBe(403);
  expect((await app.fetch(new Request(`${APP}/api/posts?status=deleted`), runtime.ctx)).status).toBe(400);
});

it("pages through every published post instead of stopping at the first page", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  for (let index = 0; index < 45; index += 1) {
    await app.fetch(post("/api/posts", { title: `Post ${String(index).padStart(2, "0")}`, status: "published" }), runtime.ctx);
  }
  const { titles, pages } = await listAll(runtime.ctx);
  expect(pages).toBe(3);
  expect(new Set(titles).size).toBe(45);
  expect(titles[0]).toBe("Post 44");

  expect((await app.fetch(new Request(`${APP}/api/posts?cursor=%3Cbad%3E`), runtime.ctx)).status).toBe(400);
});

describe("posts from other sites", () => {
  const otherApp = "https://attacker.apps.userland.fun";

  it("refuses admin actions posted from another app's page", async () => {
    const runtime = createFakeRuntime(manifest, { user: admin });
    const draft = await (await app.fetch(post("/api/posts", { title: "Draft" }), runtime.ctx)).json();

    // A hidden text/plain form on another *.apps.userland.fun app, as in the audit.
    const forged = post("/api/posts", '{"title":"pwn","status":"published","x":"="}', { "content-type": "text/plain", origin: otherApp });
    expect((await app.fetch(forged, runtime.ctx)).status).toBe(403);
    expect((await app.fetch(post(`/api/posts/${draft.post.id}/publish`, "", { origin: otherApp }), runtime.ctx)).status).toBe(403);
    expect((await app.fetch(post("/api/uploads", "hello", { "content-type": "text/plain", origin: otherApp }), runtime.ctx)).status).toBe(403);
    // Sandboxed frames send Origin: null.
    expect((await app.fetch(post("/api/posts", { title: "x" }, { "content-type": "application/json", origin: "null" }), runtime.ctx)).status).toBe(403);
    // Some browsers omit Origin but still send Sec-Fetch-Site.
    expect((await app.fetch(post("/api/posts", { title: "x" }, { "content-type": "application/json", "sec-fetch-site": "same-site" }), runtime.ctx)).status).toBe(403);

    expect(runtime.state.rows.get("posts")!.map((row) => [row.title, row.status])).toEqual([["Draft", "draft"]]);
    expect(runtime.state.files).toHaveLength(0);
  });

  it("accepts the same actions from the blog's own pages", async () => {
    const runtime = createFakeRuntime(manifest, { user: admin });
    const response = await app.fetch(post("/api/posts", { title: "Mine" }, { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin" }), runtime.ctx);
    expect(response.status).toBe(201);
  });

  it("only accepts JSON bodies on the post routes", async () => {
    const runtime = createFakeRuntime(manifest, { user: admin });
    const plain = await app.fetch(post("/api/posts", '{"title":"pwn"}', { "content-type": "text/plain" }), runtime.ctx);
    expect(plain.status).toBe(415);
    expect(runtime.state.rows.get("posts")).toHaveLength(0);
  });
});

it("answers 400 for bodies that are not a JSON object", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  for (const body of ["{not json", "null", "[1]", '"text"']) {
    const response = await app.fetch(post("/api/posts", body), runtime.ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  }
});

it("answers 404 when publishing a post that does not exist", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  expect((await app.fetch(post("/api/posts/row_missing/publish", {}), runtime.ctx)).status).toBe(404);
});

it("escapes post content on public pages", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  const created = await app.fetch(post("/api/posts", { title: "<script>x</script>", body: "b", status: "published" }), runtime.ctx);
  const { post: row } = await created.json();
  const page = await app.fetch(new Request(`${APP}/posts/${row.id}`), runtime.ctx);
  expect(await page.text()).not.toContain("<script>x</script>");
});

it("uploads media only with an allowed content type", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  const upload = await app.fetch(post("/api/uploads", "hello", { "content-type": "text/plain", "x-filename": "hello.txt" }), runtime.ctx);
  expect(upload.status).toBe(201);
  await expect(app.fetch(post("/api/uploads", "<svg/>", { "content-type": "image/svg+xml" }), runtime.ctx)).rejects.toThrow(/not allowed/u);
});

it("answers unknown paths with 404", async () => {
  const runtime = createFakeRuntime(manifest);
  expect((await app.fetch(new Request(`${APP}/nope`), runtime.ctx)).status).toBe(404);
});

it("answers HEAD on every page like GET, without a body", async () => {
  const runtime = createFakeRuntime(manifest, { user: admin });
  const created = await app.fetch(post("/api/posts", { title: "Hello", body: "World", status: "published" }), runtime.ctx);
  const { post: row } = await created.json();
  expect((await expectHeadLikeGet(app, runtime.ctx, `${APP}/api/posts`)).status).toBe(200);
  expect((await expectHeadLikeGet(app, runtime.ctx, `${APP}/api/posts?status=draft`)).status).toBe(200);
  expect((await expectHeadLikeGet(app, runtime.ctx, `${APP}/posts/${row.id}`)).status).toBe(200);
  expect((await expectHeadLikeGet(app, runtime.ctx, `${APP}/posts/missing`)).status).toBe(404);
});

it("shows the editor only to admins and links everyone else to sign-in", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(path.resolve(import.meta.dirname, "../public/assets/app.js"), "utf8");
  expect(script).toContain("/_userland/auth/session");
  expect(script).toContain("/_userland/auth/login?return_to=");
  expect(script).toContain('user.roles.includes("admin")');
});

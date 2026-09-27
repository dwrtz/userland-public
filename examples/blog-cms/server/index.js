const MAX_JSON_BYTES = 200_000;
const PAGE_SIZE = 20;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

function html(body, init = {}) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Userland Blog CMS</title></head><body>${body}</body></html>`, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Admin actions must come from this app's own pages. Userland's sign-in cookie
// is SameSite=Lax and every app on apps.userland.fun counts as the same "site",
// so without this check a page on another app could post a hidden form here
// while an admin is signed in, and publish or upload in their name. Browsers
// send an Origin header on every POST (a sandboxed page sends "null", which is
// rejected too). Requests with neither Origin nor Sec-Fetch-Site (curl, tests)
// are not from a browser, so they cannot carry a visitor's cookie by accident.
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// Reads a JSON object body. Requiring the JSON content type also stops plain
// HTML forms, which can only send form or text bodies, from reaching the route.
async function readJson(request) {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return { response: json({ error: "json_required" }, { status: 415 }) };
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
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

// Returns an error response when the request is not from a signed-in admin.
// Checking in app code keeps the 401/403 bodies in the same JSON shape as the
// other errors; an uncaught ctx.auth.requireRole error would also answer 401
// or 403, with the platform's own body.
async function adminOnly(request, ctx) {
  const user = await ctx.auth.currentUser(request);
  if (!user) {
    return json({ error: "sign_in_required" }, { status: 401 });
  }
  if (!user.roles.includes("admin")) {
    return json({ error: "admin_role_required" }, { status: 403 });
  }
  return null;
}

function listItem(post) {
  return {
    id: post.id,
    title: post.title,
    status: post.status,
    image_url: post.image_url,
    published_at: post.published_at
  };
}

// Anyone can list published posts. `?status=draft` lists drafts for admins.
// Each response holds one page; pass the returned `cursor` back as `?cursor=`
// to read the next one. No `cursor` means there are no more posts.
async function handleList(request, ctx, url) {
  const status = url.searchParams.get("status") ?? "published";
  if (status !== "published" && status !== "draft") {
    return json({ error: "invalid_status" }, { status: 400 });
  }
  if (status === "draft") {
    const denied = await adminOnly(request, ctx);
    if (denied) return denied;
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && !/^[A-Za-z0-9+/=_-]{1,200}$/u.test(cursor)) {
    return json({ error: "invalid_cursor" }, { status: 400 });
  }
  // `where` and `order_by` fields must be indexed; see the by_status index.
  // Drafts have no published_at yet, so they come back most recently edited first.
  const page = await ctx.data.collection("posts").list({
    where: { status },
    ...(status === "published" ? { order_by: [{ field: "published_at", direction: "desc" }] } : {}),
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {})
  });
  return json(
    { posts: page.rows.map(listItem), ...(page.cursor ? { cursor: page.cursor } : {}) },
    status === "draft" ? { headers: { "cache-control": "no-store" } } : {}
  );
}

async function handleCreate(request, ctx) {
  const denied = await adminOnly(request, ctx);
  if (denied) return denied;
  const { body: input, response } = await readJson(request);
  if (response) return response;
  const title = String(input.title ?? "").trim() || "Untitled";
  const publish = input.status === "published";
  const post = await ctx.data.collection("posts").create({
    title: title.slice(0, 200),
    body: String(input.body ?? ""),
    image_url: String(input.image_url ?? "").slice(0, 2000),
    status: publish ? "published" : "draft",
    ...(publish ? { published_at: new Date().toISOString() } : {})
  });
  await ctx.log.info("post created", { post_id: post.id });
  return json({ post }, { status: 201 });
}

async function handlePublish(request, ctx, postId) {
  const denied = await adminOnly(request, ctx);
  if (denied) return denied;
  const existing = await ctx.data.collection("posts").get(postId);
  if (!existing) {
    return json({ error: "post_not_found" }, { status: 404 });
  }
  const post = await ctx.data.collection("posts").update(postId, {
    status: "published",
    published_at: new Date().toISOString()
  });
  await ctx.log.info("post published", { post_id: post.id });
  return json({ post });
}

async function handleUpload(request, ctx) {
  const denied = await adminOnly(request, ctx);
  if (denied) return denied;
  const body = await request.arrayBuffer();
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  // The media store only accepts the content types and size declared in the manifest.
  const file = await ctx.files.store("media").createUpload(body, {
    filename: request.headers.get("x-filename") ?? "upload.bin",
    content_type: contentType
  });
  await ctx.log.info("media uploaded", { file_id: file.file_id });
  return json({ file }, { status: 201 });
}

async function handlePublicPost(ctx, postId) {
  const post = postId ? await ctx.data.collection("posts").get(postId) : null;
  if (!post || post.status !== "published") {
    return html("<h1>Not found</h1>", { status: 404 });
  }
  const image = post.image_url ? `<img src="${escapeHtml(post.image_url)}" alt="">` : "";
  return html(`<main>${image}<h1>${escapeHtml(post.title)}</h1><article>${escapeHtml(post.body)}</article></main>`);
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

    if (request.method === "POST" && !isSameOrigin(request, url)) {
      return json({ error: "cross_origin_request" }, { status: 403 });
    }

    if (url.pathname === "/api/posts" && request.method === "GET") {
      return await handleList(request, ctx, url);
    }
    if (url.pathname === "/api/posts" && request.method === "POST") {
      return await handleCreate(request, ctx);
    }
    const publishMatch = /^\/api\/posts\/([A-Za-z0-9_-]{1,100})\/publish$/u.exec(url.pathname);
    if (publishMatch && request.method === "POST") {
      return await handlePublish(request, ctx, publishMatch[1]);
    }
    if (url.pathname === "/api/uploads" && request.method === "POST") {
      return await handleUpload(request, ctx);
    }
    if (url.pathname.startsWith("/posts/") && request.method === "GET") {
      return await handlePublicPost(ctx, url.pathname.slice("/posts/".length));
    }

    return html('<h1>Page not found</h1><p><a href="/">Back to the blog</a></p>', { status: 404 });
  }
};

export default app;

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

// Returns an error response when the request is not from a signed-in admin.
// Using currentUser keeps the 401/403 decision in app code instead of letting
// a thrown auth error become a generic 500.
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

async function handleList(ctx) {
  // `where` and `order_by` fields must be indexed; see the by_status index.
  const posts = await ctx.data.collection("posts").list({
    where: { status: "published" },
    order_by: [{ field: "published_at", direction: "desc" }],
    limit: 50
  });
  return json({
    posts: posts.rows.map((post) => ({
      id: post.id,
      title: post.title,
      image_url: post.image_url,
      published_at: post.published_at
    }))
  });
}

async function handleCreate(request, ctx) {
  const denied = await adminOnly(request, ctx);
  if (denied) return denied;
  const input = await request.json();
  const publish = input.status === "published";
  const post = await ctx.data.collection("posts").create({
    title: String(input.title ?? "Untitled").slice(0, 200),
    body: String(input.body ?? ""),
    image_url: String(input.image_url ?? ""),
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
  const post = await ctx.data.collection("posts").get(postId);
  if (!post || post.status !== "published") {
    return html("<h1>Not found</h1>", { status: 404 });
  }
  const image = post.image_url ? `<img src="${escapeHtml(post.image_url)}" alt="">` : "";
  return html(`<main>${image}<h1>${escapeHtml(post.title)}</h1><article>${escapeHtml(post.body)}</article></main>`);
}

export default {
  async fetch(request, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/posts" && request.method === "GET") {
      return await handleList(ctx);
    }
    if (url.pathname === "/api/posts" && request.method === "POST") {
      return await handleCreate(request, ctx);
    }
    if (url.pathname.startsWith("/api/posts/") && url.pathname.endsWith("/publish") && request.method === "POST") {
      const postId = url.pathname.split("/")[3];
      return await handlePublish(request, ctx, postId);
    }
    if (url.pathname === "/api/uploads" && request.method === "POST") {
      return await handleUpload(request, ctx);
    }
    if (url.pathname.startsWith("/posts/") && request.method === "GET") {
      return await handlePublicPost(ctx, url.pathname.slice("/posts/".length));
    }

    return html("<h1>Userland Blog CMS</h1><p>Use the static editor to manage posts.</p>");
  }
};

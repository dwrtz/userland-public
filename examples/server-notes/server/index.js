function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

async function listNotes(ctx) {
  // `where` fields must be indexed (see the by_status index). Without an
  // `order_by`, rows come back most recently updated first.
  const notes = await ctx.data.collection("notes").list({
    where: { status: "open" },
    limit: 50
  });
  return json({
    notes: notes.rows.map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      status: note.status,
      created_at: note.created_at
    }))
  });
}

async function createNote(request, ctx) {
  const input = await request.json();
  const title = String(input.title ?? "").trim();
  if (!title) {
    return json({ error: "title_required" }, { status: 400 });
  }
  const note = await ctx.data.collection("notes").create({
    title: title.slice(0, 200),
    body: String(input.body ?? "").slice(0, 10000),
    status: "open"
  });
  // Log identifiers only, never note content.
  await ctx.log.info("note created", { note_id: note.id });
  return json({ note: { id: note.id, title: note.title, body: note.body, status: note.status, created_at: note.created_at } }, { status: 201 });
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
    if (url.pathname === "/api/notes" && request.method === "GET") {
      return await listNotes(ctx);
    }
    if (url.pathname === "/api/notes" && request.method === "POST") {
      return await createNote(request, ctx);
    }
    return new Response("Not found", { status: 404 });
  }
};

export default app;

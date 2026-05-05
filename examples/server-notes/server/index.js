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
  const notes = await ctx.data.collection("notes").list({
    where: { status: "open" },
    order_by: [{ field: "created_at", direction: "desc" }]
  });
  return json({ notes: notes.rows });
}

async function createNote(request, ctx) {
  const input = await request.json();
  const note = await ctx.data.collection("notes").create({
    title: String(input.title ?? "Untitled note"),
    body: String(input.body ?? ""),
    status: "open"
  });
  await ctx.log.info("note created", { note_id: note.id });
  return json({ note }, { status: 201 });
}

export default {
  async fetch(request, ctx) {
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


// Anyone can add a note, so these limits keep one person with a script from
// filling the app's data quota (1,000 rows on Free). Apps cannot see a
// visitor's IP address, so the limits apply to the whole app, not per person.
const LIMITS = {
  title: 200,
  body: 2000,
  bodyBytes: 16_000,
  notesPerHour: 30,
  openNotes: 300,
  // Notes older than this are deleted to make room, a few at a time.
  keepDays: 30,
  deletesPerRequest: 10
};
const PAGE_SIZE = 20;
const HOUR = 60 * 60 * 1000;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

// Notes may only be added from this app's page. There is no sign-in here, but
// without the check any other site could make its visitors' browsers add
// notes. Browsers send Origin on every POST (a sandboxed page sends "null",
// which is rejected too). curl and other non-browser clients send neither.
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// Reads a JSON object body, or returns the error response to send.
async function readJson(request) {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return { response: json({ error: "json_required" }, { status: 415 }) };
  }
  const text = await request.text();
  if (text.length > LIMITS.bodyBytes) {
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

function publicNote(note) {
  return { id: note.id, title: note.title, body: note.body, status: note.status, created_at: note.created_at };
}

// One page of open notes, newest first. Pass the returned `cursor` back as
// `?cursor=` for the next page; no `cursor` means that was the last page.
async function listNotes(ctx, url) {
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && !/^[A-Za-z0-9+/=_-]{1,200}$/u.test(cursor)) {
    return json({ error: "invalid_cursor" }, { status: 400 });
  }
  // `where` fields must be indexed (see the by_status index). Without an
  // `order_by`, rows come back most recently updated first, and notes are
  // never edited, so that is newest first.
  const page = await ctx.data.collection("notes").list({
    where: { status: "open" },
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {})
  });
  return json({ notes: page.rows.map(publicNote), ...(page.cursor ? { cursor: page.cursor } : {}) });
}

// Reads every open note's age (never more than LIMITS.openNotes plus a few).
async function noteAges(ctx, now) {
  const notes = ctx.data.collection("notes");
  const ages = { total: 0, lastHour: 0, expired: [] };
  let cursor;
  do {
    const page = await notes.list({ where: { status: "open" }, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const note of page.rows) {
      const age = now - Date.parse(note.created_at);
      ages.total += 1;
      if (age < HOUR) ages.lastHour += 1;
      if (age > LIMITS.keepDays * 24 * HOUR) ages.expired.push(note.id);
    }
    cursor = page.cursor;
  } while (cursor);
  return ages;
}

async function createNote(request, ctx) {
  const { body: input, response } = await readJson(request);
  if (response) return response;

  // Honeypot: the page hides the "website" field, so only bots fill it in.
  // Answer as if it worked so they have no reason to try again.
  if (input.website) {
    await ctx.log.warn("note ignored", { reason: "honeypot" });
    return json({ received: true }, { status: 202 });
  }

  const title = String(input.title ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (!title) {
    return json({ error: "title_required" }, { status: 400 });
  }
  if (title.length > LIMITS.title || body.length > LIMITS.body) {
    return json({ error: "note_too_long", max_title_length: LIMITS.title, max_body_length: LIMITS.body }, { status: 400 });
  }

  // These checks read before they write, so a burst of simultaneous posts can
  // go a few notes over; they are a brake, not a lock.
  const now = Date.now();
  const ages = await noteAges(ctx, now);
  if (ages.lastHour >= LIMITS.notesPerHour) {
    return json({ error: "too_many_notes", retry_after_minutes: 60 }, { status: 429, headers: { "retry-after": "3600" } });
  }
  const notes = ctx.data.collection("notes");
  const expired = ages.expired.slice(0, LIMITS.deletesPerRequest);
  for (const id of expired) {
    await notes.delete(id);
  }
  if (ages.total - expired.length >= LIMITS.openNotes) {
    return json({ error: "board_full" }, { status: 503 });
  }

  const note = await notes.create({ title, body, status: "open" });
  // Log identifiers only, never note content.
  await ctx.log.info("note created", { note_id: note.id, ...(expired.length ? { expired_deleted: expired.length } : {}) });
  return json({ note: publicNote(note) }, { status: 201 });
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
      return await listNotes(ctx, url);
    }
    if (url.pathname === "/api/notes" && request.method === "POST") {
      if (!isSameOrigin(request, url)) return json({ error: "cross_origin_request" }, { status: 403 });
      return await createNote(request, ctx);
    }
    return new Response("Not found", { status: 404 });
  }
};

export default app;

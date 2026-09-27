// Data access for the two managed collections declared in manifest.userland.json:
//
//   links  - links and featured products shown on the public page
//   inbox  - email-list signups and contact-form messages
//
// Every read and write takes a `scope`. In a normal app the scope is always ""
// (the owner's real data). The public demo gives each visitor their own scope
// so nobody sees what another visitor typed (see server/demo.js).
//
// Userland queries match `where` fields exactly and can only filter on indexed
// fields, so each collection has one index on `demo_key`. Sorting happens here
// in JavaScript because the lists are small (a link page has a few dozen rows).

import { starterLinks } from "./content.js";

export const MAX_ROWS = 100; // Userland's per-query limit.

// Reads every matching row, following the cursor past the 100-row page size.
async function listAll(ctx, name, where) {
  const rows = [];
  let cursor;
  do {
    const page = await ctx.data.collection(name).list({ where, limit: MAX_ROWS, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

export async function listLinks(ctx, scope) {
  const rows = await listAll(ctx, "links", { demo_key: scope });
  return rows.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export async function getLink(ctx, scope, id) {
  const row = await ctx.data.collection("links").get(id);
  // A row id from another scope is treated as missing.
  return row && (row.demo_key ?? "") === scope ? row : null;
}

export async function createLink(ctx, scope, input, position) {
  return await ctx.data.collection("links").create({
    title: input.title,
    url: input.url,
    note: input.note ?? "",
    price: input.price ?? "",
    picture: input.picture ?? "plate",
    featured: input.featured === true,
    visible: input.visible !== false,
    position,
    clicks: input.clicks ?? 0,
    demo_key: scope
  });
}

export async function updateLink(ctx, id, patch) {
  return await ctx.data.collection("links").update(id, patch);
}

export async function deleteLink(ctx, id) {
  await ctx.data.collection("links").delete(id);
}

// Adds the starter links from content.js after any existing links.
export async function addStarterLinks(ctx, scope) {
  const existing = await listLinks(ctx, scope);
  const start = nextPosition(existing);
  await Promise.all(starterLinks.map((link, index) => createLink(ctx, scope, link, start + index)));
}

export function nextPosition(links) {
  return links.reduce((max, link) => Math.max(max, link.position ?? 0), 0) + 1;
}

// Swaps a link with its neighbour. `direction` is -1 (up) or 1 (down).
export async function moveLink(ctx, scope, id, direction) {
  const links = await listLinks(ctx, scope);
  const index = links.findIndex((link) => link.id === id);
  const other = links[index + direction];
  if (index === -1 || !other) return;
  const current = links[index];
  // Renumber so positions stay unique even if two rows shared a position.
  const a = index + 1;
  const b = index + direction + 1;
  await Promise.all([updateLink(ctx, current.id, { position: b }), updateLink(ctx, other.id, { position: a })]);
}

export async function recordClick(ctx, link) {
  await updateLink(ctx, link.id, { clicks: (link.clicks ?? 0) + 1 });
}

export async function listInbox(ctx, scope, kind) {
  const rows = await listAll(ctx, "inbox", { demo_key: scope, kind });
  return rows.sort((a, b) => String(b.received_at ?? b.created_at).localeCompare(String(a.received_at ?? a.created_at)));
}

export async function getInboxItem(ctx, scope, id) {
  const row = await ctx.data.collection("inbox").get(id);
  return row && (row.demo_key ?? "") === scope ? row : null;
}

export async function createInboxItem(ctx, scope, input) {
  return await ctx.data.collection("inbox").create({
    kind: input.kind,
    name: input.name ?? "",
    email: input.email,
    topic: input.topic ?? "",
    message: input.message ?? "",
    status: input.status ?? "new",
    received_at: input.received_at ?? new Date().toISOString(),
    demo_key: scope
  });
}

export async function setInboxStatus(ctx, id, status) {
  return await ctx.data.collection("inbox").update(id, { status });
}

// Email-list signups are unique per address. A repeat signup is a success for
// the visitor but does not create a second row. (Partly hidden demo addresses,
// see server/demo.js, can't be told apart, so they are never merged.)
export async function addSignup(ctx, scope, { name, email }) {
  const existing = email.includes("\u2022") ? [] : await listInbox(ctx, scope, "signup");
  const match = existing.find((row) => String(row.email).toLowerCase() === email.toLowerCase());
  if (match) {
    if (match.status === "archived") await setInboxStatus(ctx, match.id, "new");
    return match;
  }
  return await createInboxItem(ctx, scope, { kind: "signup", name, email });
}

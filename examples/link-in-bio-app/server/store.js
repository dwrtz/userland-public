// Data access for the two managed collections declared in manifest.userland.json:
//
//   links  - links and featured products shown on the public page, plus small
//            "tap tally" rows that hold each link's tap count (see recordTap)
//   inbox  - email-list signups and contact-form messages
//
// Every read and write takes a `scope`. In a normal app the scope is always ""
// (the owner's real data). The public demo gives each visitor their own scope
// so nobody sees what another visitor typed (see server/demo.js).
//
// Userland queries match `where` fields exactly and can only filter or sort on
// indexed fields. The Free plan allows two indexes per collection:
//
//   links.by_scope         demo_key                             one page's links
//   links.by_slot          slot (unique)                        tap tallies, starter links
//   inbox.by_scope_status  demo_key, kind, status, received_at  inbox tabs, newest first
//   inbox.by_slot          slot (unique)                        one signup per address,
//                                                               a daily limit per sender
//
// A unique `slot` is how this file stops duplicates even when two requests
// arrive at the same moment: the second create with the same slot fails with
// `unique_conflict`, which is caught here. Slots start with the scope, so demo
// copies never collide with each other or with real rows. Rows that don't
// need a slot leave it out.

import { starterLinks } from "./content.js";

export const MAX_ROWS = 100; // Userland's per-query limit.

// Owner inbox pages. Each tab reads one page at a time, newest first, with an
// "Older" link for the next page, so a long inbox never loads all at once.
export const MESSAGES_PER_PAGE = 25;
export const ADDRESSES_PER_PAGE = 100;
// A spreadsheet download reads at most this many pages of 100 addresses in one
// request (Userland limits how many data calls one request can make). A longer
// list downloads in parts.
export const EXPORT_PAGES = 15;

// Limits that keep a script from filling the inbox (and the plan's saved-item
// allowance, which links, messages, and signups share). Change them here.
export const NOTES_PER_ADDRESS_PER_DAY = 3; // contact messages from one email address per day
export const MAX_NEW_MESSAGES = 100; // unread messages before the contact form pauses
export const SIGNUPS_PER_DAY = 200; // new email-list signups per day (a multiple of 100)

const TAP_TRIES = 6;

export function isUniqueConflict(error) {
  return error?.code === "unique_conflict";
}

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

function slotFor(scope, ...parts) {
  return [scope, ...parts].join("/");
}

export const starterSlot = (scope, number) => slotFor(scope, "starter", String(number));
export const signupSlot = (scope, email) => slotFor(scope, "signup", String(email).toLowerCase());

// ---------------------------------------------------------------- links

const isTally = (row) => String(row.slot ?? "").includes("/taps/");
const tallyPrefix = (link) => slotFor(link.demo_key ?? "", "taps", link.id, "");
const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

// Link rows and tally rows share a scope; a page has a few dozen of them.
async function scopeRows(ctx, scope) {
  return await listAll(ctx, "links", { demo_key: scope });
}

export async function listLinks(ctx, scope) {
  return (await scopeRows(ctx, scope)).filter((row) => !isTally(row)).sort(byPosition);
}

// Links with their current tap counts, for the owner view.
export async function listLinksWithTaps(ctx, scope) {
  const rows = await scopeRows(ctx, scope);
  return rows
    .filter((row) => !isTally(row))
    .sort(byPosition)
    .map((link) => ({ ...link, clicks: tapCount(link, rows) }));
}

function tapCount(link, rows) {
  const prefix = tallyPrefix(link);
  // Taps counted before tally rows existed (and the demo's sample counts) sit on the link itself.
  return rows.filter((row) => String(row.slot ?? "").startsWith(prefix)).reduce((max, row) => Math.max(max, row.clicks ?? 0), link.clicks ?? 0);
}

export async function getLink(ctx, scope, id) {
  const row = await ctx.data.collection("links").get(id);
  // A row id from another scope, or a tally row, is treated as missing.
  return row && (row.demo_key ?? "") === scope && !isTally(row) ? row : null;
}

export async function createLink(ctx, scope, input, position, slot) {
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
    demo_key: scope,
    ...(slot ? { slot } : {})
  });
}

// Only the fields the owner edits. Tap counts never go through here.
export async function updateLink(ctx, id, patch) {
  return await ctx.data.collection("links").update(id, patch);
}

// Deletes a link and its tap tally.
export async function deleteLink(ctx, link) {
  const links = ctx.data.collection("links");
  const prefix = tallyPrefix(link);
  const tallies = (await scopeRows(ctx, link.demo_key ?? "")).filter((row) => String(row.slot ?? "").startsWith(prefix));
  await Promise.all([links.delete(link.id), ...tallies.map((row) => links.delete(row.id))]);
}

// Adds the starter links from content.js after any existing links. Each one
// has a fixed slot, so a double-click (or two first visits to the demo at once)
// adds them only once. Returns how many were added.
export async function addStarterLinks(ctx, scope) {
  const existing = await listLinks(ctx, scope);
  const start = nextPosition(existing);
  const results = await Promise.allSettled(starterLinks.map((link, index) => createLink(ctx, scope, link, start + index, starterSlot(scope, index + 1))));
  let added = 0;
  for (const result of results) {
    if (result.status === "fulfilled") added += 1;
    else if (!isUniqueConflict(result.reason)) throw result.reason;
  }
  return added;
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

// Counts one tap on a link and returns the new count (or null if it gave up).
//
// Taps live in their own small "tally" rows, not on the link, so a tap never
// writes over a change the owner is saving. Each link has one current tally
// whose slot ends in its count (<scope>/taps/<link id>/<count>). A tap creates
// the row for count + 1. The slot is unique, so when two taps arrive together
// only one can create it; the other reads again and creates count + 2. Older
// tally rows are then deleted.
export async function recordTap(ctx, link) {
  const links = ctx.data.collection("links");
  const prefix = tallyPrefix(link);
  for (let attempt = 0; attempt < TAP_TRIES; attempt += 1) {
    const tallies = (await scopeRows(ctx, link.demo_key ?? "")).filter((row) => String(row.slot ?? "").startsWith(prefix));
    const count = tallies.reduce((max, row) => Math.max(max, row.clicks ?? 0), link.clicks ?? 0);
    try {
      await links.create({ demo_key: link.demo_key ?? "", slot: `${prefix}${count + 1}`, clicks: count + 1 });
    } catch (error) {
      if (isUniqueConflict(error)) continue;
      throw error;
    }
    await Promise.all(tallies.map((row) => links.delete(row.id)));
    return count + 1;
  }
  return null;
}

// ---------------------------------------------------------------- inbox

// Which rows each inbox tab shows. Each is one indexed query.
export const INBOX_TABS = {
  messages: { kind: "message", status: "new" },
  replied: { kind: "message", status: "replied" },
  list: { kind: "signup", status: "new" },
  archived: { status: "archived" }
};

const NEWEST_FIRST = [{ field: "received_at", direction: "desc" }];

// One page of a tab, newest first. Pass the returned cursor back for the next page.
export async function listInboxPage(ctx, scope, tab, { cursor, limit } = {}) {
  const page = await ctx.data.collection("inbox").list({
    where: { demo_key: scope, ...INBOX_TABS[tab] },
    order_by: NEWEST_FIRST,
    limit: limit ?? (tab === "list" ? ADDRESSES_PER_PAGE : MESSAGES_PER_PAGE),
    ...(cursor ? { cursor } : {})
  });
  return { rows: page.rows, cursor: page.cursor ?? null };
}

// Counts rows in a tab, reading at most `pages` pages. `more` is true when
// there are more rows than it counted.
export async function countInbox(ctx, scope, tab, pages = 1) {
  let count = 0;
  let cursor;
  for (let page = 0; page < pages; page += 1) {
    const result = await listInboxPage(ctx, scope, tab, { cursor, limit: MAX_ROWS });
    count += result.rows.length;
    cursor = result.cursor;
    if (!cursor) return { count, more: false };
  }
  return { count, more: true };
}

// Up to EXPORT_PAGES pages of the email list, starting at `cursor`. Addresses
// saved twice by older versions of this app appear once.
export async function exportSignups(ctx, scope, cursor) {
  const rows = [];
  const seen = new Set();
  let next = cursor || null;
  for (let page = 0; page < EXPORT_PAGES; page += 1) {
    const result = await listInboxPage(ctx, scope, "list", { cursor: next, limit: MAX_ROWS });
    for (const row of result.rows) {
      const address = String(row.email).toLowerCase();
      if (!seen.has(address)) rows.push(row);
      seen.add(address);
    }
    next = result.cursor;
    if (!next) break;
  }
  return { rows, cursor: next };
}

export async function getInboxItem(ctx, scope, id) {
  const row = await ctx.data.collection("inbox").get(id);
  return row && (row.demo_key ?? "") === scope && row.kind ? row : null;
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
    demo_key: scope,
    ...(input.slot ? { slot: input.slot } : {})
  });
}

export async function setInboxStatus(ctx, id, status) {
  return await ctx.data.collection("inbox").update(id, { status });
}

export async function deleteInboxItem(ctx, id) {
  await ctx.data.collection("inbox").delete(id);
}

// Archives new messages, or deletes archived items, up to `limit` at a time
// (one request can only make so many data calls). Returns how many it changed
// and whether more are left.
export async function archiveNewMessages(ctx, scope, limit) {
  const page = await listInboxPage(ctx, scope, "messages", { limit });
  await Promise.all(page.rows.map((row) => setInboxStatus(ctx, row.id, "archived")));
  return { count: page.rows.length, more: Boolean(page.cursor) };
}

export async function deleteArchived(ctx, scope, limit) {
  const page = await listInboxPage(ctx, scope, "archived", { limit });
  await Promise.all(page.rows.map((row) => deleteInboxItem(ctx, row.id)));
  return { count: page.rows.length, more: Boolean(page.cursor) };
}

// Email-list signups are unique per address: the slot is the address, so even
// two signups at the same moment make one row. A repeat signup is a success
// for the visitor but changes nothing, and an address the owner removed stays
// removed. (Partly hidden demo addresses, see server/demo.js, can't be told
// apart, so they get no slot and are never merged.) Returns true when added.
export async function addSignup(ctx, scope, { name, email }) {
  const slot = email.includes("•") ? null : slotFor(scope, "signup", email.toLowerCase());
  try {
    await createInboxItem(ctx, scope, { kind: "signup", name, email, slot });
    return true;
  } catch (error) {
    if (slot && isUniqueConflict(error)) return false;
    throw error;
  }
}

// True when SIGNUPS_PER_DAY or more people joined in the last 24 hours.
export async function signupsBusy(ctx, scope, now = Date.now()) {
  const since = now - 24 * 3_600_000;
  let cursor;
  for (let page = 0; page < Math.ceil(SIGNUPS_PER_DAY / MAX_ROWS); page += 1) {
    const result = await ctx.data.collection("inbox").list({ where: { demo_key: scope, kind: "signup" }, order_by: NEWEST_FIRST, limit: MAX_ROWS, ...(cursor ? { cursor } : {}) });
    if (result.rows.some((row) => Date.parse(row.received_at) < since) || !result.cursor) return false;
    cursor = result.cursor;
  }
  return true;
}

// True when MAX_NEW_MESSAGES unread messages are waiting.
export async function inboxFull(ctx, scope) {
  const page = await listInboxPage(ctx, scope, "messages", { limit: Math.min(MAX_NEW_MESSAGES, MAX_ROWS) });
  return page.rows.length >= MAX_NEW_MESSAGES;
}

// Saves a contact message. Each email address gets NOTES_PER_ADDRESS_PER_DAY
// numbered slots per day (…/note/<address>/<day>/1, /2, /3), so the limit
// holds even for messages sent at the same moment. Returns null when the
// address has used them all today.
export async function addMessage(ctx, scope, input, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const address = String(input.email).toLowerCase();
  for (let n = 1; n <= NOTES_PER_ADDRESS_PER_DAY; n += 1) {
    try {
      return await createInboxItem(ctx, scope, { ...input, kind: "message", slot: slotFor(scope, "note", address, day, String(n)) });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
  }
  return null;
}

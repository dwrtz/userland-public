// DEMO MODE ------------------------------------------------------------------
//
// Everything that makes the public demo at waitlist-demo.apps.userland.fun
// different from a real waitlist lives in this file:
//
//   - The owner view opens without signing in.
//   - It shows made-up sample signups plus only the signups this visitor added.
//     A visitor's signups are tagged with a random demo key that travels in the
//     link (?demo=...), because the app never sees ordinary browser cookies.
//     Nobody without that link can see those signups.
//   - Status changes on a sample signup save a private copy for this visitor
//     instead of changing what other visitors see.
//   - Visitor signups are deleted a day after they were saved, and the whole
//     demo holds at most MAX_DEMO_ROWS of them, so it can't fill up the app.
//   - Every page carries a noindex tag and a small "Demo app" note.
//
// Demo mode is only on for the hostnames in DEMO_HOSTS: the demo's named
// address and, on purpose, the demo app's own apps.userland.fun address, so no
// page of the demo deployment collects real signups or gets indexed. A copy of
// this app published anywhere else (including your own <app-id> address) runs
// as a normal waitlist with a signed-in owner.
//
// To remove the demo from your own copy:
//   1. Delete this file.
//   2. In server/index.js, delete the demo import and every `if (demo)` branch.
//   3. In manifest.userland.json, delete the "demo-signups" collection.
//   4. In tests/, delete the "public demo" tests.
// -----------------------------------------------------------------------------

import { STATUSES, listAll, toSignup, withReferralCounts } from "./waitlist.js";
import { escapeHtml } from "./views.js";

// Both belong to the Userland demo deployment only; replace them if you publish your own demo.
export const DEMO_HOSTS = new Set(["waitlist-demo.apps.userland.fun", "2yuafo8fwc1sdrlhysh.apps.userland.fun"]);
export const DEMO_COLLECTION = "demo-signups";
export const EXAMPLE_PAGE_URL = "https://userland.fun/examples/waitlist-app/";
export const MAX_SIGNUPS_PER_VISITOR = 30;
// Across every visitor. Old rows are deleted as new ones come in, so this is
// only reached when a lot of people (or a bot) use the demo on the same day.
export const MAX_DEMO_ROWS = 400;
const KEEP_FOR_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 20;

const KEY_PATTERN = /^[a-f0-9]{32}$/u;

export class DemoLimitError extends Error {
  constructor(
    heading = "That's plenty for a demo.",
    message = `This demo keeps up to ${MAX_SIGNUPS_PER_VISITOR} signups per visitor.`
  ) {
    super(message);
    this.heading = heading;
    this.code = "demo_limit";
  }
}

function demoFullError() {
  return new DemoLimitError("The demo is busy right now.", "Lots of people tried it today. Please come back tomorrow, or open the owner view to look around.");
}

export function isDemoRequest(url) {
  return DEMO_HOSTS.has(url.hostname);
}

export function readDemoKey(value) {
  const key = String(value ?? "");
  return KEY_PATTERN.test(key) ? key : "";
}

export function newDemoKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The demo key for a signup, so its private status page can find the visitor's other demo signups.
export async function demoKeyForSignup(ctx, id) {
  const row = await ctx.data.collection(DEMO_COLLECTION).get(id);
  return row ? readDemoKey(row.demo_key) : "";
}

// A store with the same methods as signupStore() in waitlist.js.
// Without a key it only shows the sample signups and cannot save anything.
export function demoStore(ctx, key, now = new Date()) {
  const collection = () => ctx.data.collection(DEMO_COLLECTION);
  const samples = sampleSignups(now);
  const sampleById = new Map(samples.map((row) => [row.id, row]));

  async function ownRows() {
    if (!key) return [];
    const rows = await listAll(collection(), { where: { demo_key: key } });
    // Skip rows past their day even if the cleanup below hasn't reached them yet.
    return rows.filter((row) => !isExpired(row, now)).map(toSignup);
  }

  // Runs before every demo write: clears out expired rows, then checks this
  // visitor's limit and the demo-wide limit.
  async function makeRoom() {
    await sweepExpired(collection(), now);
    if ((await ownRows()).length >= MAX_SIGNUPS_PER_VISITOR) throw new DemoLimitError();
    if ((await countUpTo(collection(), MAX_DEMO_ROWS)) >= MAX_DEMO_ROWS) throw demoFullError();
  }

  const stamp = () => ({ demo_key: key, demo_expires_at: new Date(now.getTime() + KEEP_FOR_MS).toISOString() });

  async function all() {
    const own = await ownRows();
    const ownEmails = new Set(own.map((row) => row.email));
    return withReferralCounts([...samples.filter((row) => !ownEmails.has(row.email)), ...own]);
  }

  function requireKey() {
    if (!key) throw new Error("A demo key is required to save changes.");
  }

  const store = {
    all,
    async countJoined() {
      return { count: (await all()).filter((row) => row.status !== "archived").length, more: false };
    },
    async get(id) {
      if (sampleById.has(id)) {
        const sample = sampleById.get(id);
        return (await ownRows()).find((row) => row.email === sample.email) ?? sample;
      }
      if (!key) return null;
      const row = await collection().get(id);
      // Only return rows that belong to this visitor.
      return row && row.demo_key === key ? toSignup(row) : null;
    },
    async findByEmail(email) {
      return (await all()).find((row) => row.email === email) ?? null;
    },
    async findByCode(code) {
      return (await all()).find((row) => row.referral_code === code) ?? null;
    },
    async create(fields) {
      requireKey();
      await makeRoom();
      return toSignup(await collection().create({ ...fields, ...stamp() }));
    },
    async update(id, patch) {
      requireKey();
      const current = await store.get(id);
      if (!current) throw Object.assign(new Error("Signup not found."), { code: "not_found" });
      if (sampleById.has(current.id)) {
        // First change to a sample signup: save a private copy for this visitor.
        await makeRoom();
        const { id: _sampleId, referrals: _counted, ...fields } = current;
        return toSignup(await collection().create({ ...fields, ...patch, ...stamp() }));
      }
      return toSignup(await collection().update(current.id, patch));
    }
  };
  return store;
}

// ---------------------------------------------------------------------------
// Keeping the demo small.
// ---------------------------------------------------------------------------

function isExpired(row, now) {
  const expires = Date.parse(row.demo_expires_at ?? "") || Date.parse(row.created_at ?? "") + KEEP_FOR_MS;
  return expires < now.getTime();
}

// Deletes a small batch of rows whose day is up. Listing by demo_expires_at,
// oldest first, puts expired rows on the first page however many rows exist.
export async function sweepExpired(collection, now = new Date()) {
  const page = await collection.list({ order_by: [{ field: "demo_expires_at", direction: "asc" }], limit: 100 });
  const expired = page.rows.filter((row) => isExpired(row, now)).slice(0, SWEEP_BATCH);
  await Promise.all(expired.map((row) => collection.delete(row.id)));
  return expired.length;
}

// Counts rows, stopping once it reaches `max`.
async function countUpTo(collection, max) {
  let count = 0;
  let cursor;
  do {
    const page = await collection.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    count += page.rows.length;
    cursor = page.cursor;
  } while (cursor && count < max);
  return count;
}

// ---------------------------------------------------------------------------
// Page pieces. Plain language only: visitors never see words like "sandbox".
// ---------------------------------------------------------------------------

export function robotsMeta() {
  return '<meta name="robots" content="noindex,follow">';
}

// Query values that must stay on every link and form so the visitor keeps their demo.
export function persistParams(key) {
  return key ? { demo: key } : {};
}

export function demoBanner({ page, key, inviteHref }) {
  const suffix = key ? `?demo=${key}` : "";
  const messages = {
    landing: `<span>This is a demo waitlist. Join it, then peek behind the scenes.</span><a href="/admin${suffix}">Open the owner view</a>`,
    status: `<span>See your signup the way the founder does.</span><a href="/admin${suffix}">Open the owner view</a>${
      inviteHref ? `<a href="${escapeHtml(inviteHref)}">Try your invite link</a>` : ""
    }`,
    owner: `<span>Owner view of the demo. Sample signups plus any you add. Only you see your changes.</span><a href="/${suffix}">Back to the waitlist page</a>`,
    other: `<span>This is a demo waitlist.</span><a href="/${suffix}">Go to the waitlist page</a>`
  };
  const width = page === "owner" ? " wrap--wide" : "";
  return `<div class="demo-bar" role="note" aria-label="About this demo"><div class="wrap${width} demo-bar__inner">${messages[page] ?? messages.other}</div></div>`;
}

// Shown under the invite link on the private page. In the demo, a link sent to
// someone else starts a separate demo for them, so it can't credit this visitor.
export function demoShareNote(inviteHref) {
  return `<p class="demo-tip">In this demo, a link you send to someone starts a separate demo for them. To see a friend's signup move you up, <a href="${escapeHtml(inviteHref)}">open your invite link here</a> and join with another email.</p>`;
}

export function demoFooter() {
  return `<p class="demo-note">Demo app. Built with Userland. <a href="${EXAMPLE_PAGE_URL}">See how it's made</a></p>`;
}

// ---------------------------------------------------------------------------
// Made-up sample signups. Names are invented and every email uses example.com.
// The same list is generated on every request; join times are relative to now.
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Maya", "Jonah", "Priya", "Luis", "Hana", "Theo", "Amara", "Kai", "Sofia", "Marcus",
  "Ines", "Dev", "Nora", "Tariq", "Leah", "Oscar", "Yuki", "Beatriz", "Sam", "Chloe",
  "Ravi", "Elena", "Jamal", "Freya", "Diego", "Aisha", "Finn", "Lucia", "Omar", "Zoe",
  "Mateo", "Imani", "Ezra", "Greta", "Kofi", "Anya", "Rowan", "Mei", "Andre", "Tessa",
  "Nikhil", "Sasha", "Caleb", "Lina", "Joaquin", "Esme", "Hugo", "Wren", "Idris", "Clara"
];
const INITIALS = "ABCDEFGHJKLMNPRSTVW";
const CITIES = ["Austin", "Portland", "Denver", "Chicago", "Brooklyn", "Oakland", "Minneapolis", "Atlanta", "Seattle", "Boston", "Toronto", "Philadelphia"];
const FREQUENCIES = ["starting", "weekly", "weekly", "most-days", "most-days", "training"];
const GOALS = ["company", "company", "company", "consistency", "consistency", "routes", "race"];
const SAMPLE_COUNT = 140;
const SPAN_MINUTES = 26 * 24 * 60;

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleSignups(now = new Date()) {
  const random = seededRandom(90);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const nowMinute = Math.floor(now.getTime() / 60000) * 60000;
  const rows = [];
  const emails = new Set();

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const first = FIRST_NAMES[(index * 7) % FIRST_NAMES.length];
    const initial = INITIALS[(index * 5 + Math.floor(index / FIRST_NAMES.length)) % INITIALS.length];
    let email = `${first}.${initial}@example.com`.toLowerCase();
    if (emails.has(email)) email = email.replace("@", `${index}@`);
    emails.add(email);

    // Older signups first; the list picks up speed as launch gets closer.
    const age = Math.pow(1 - index / SAMPLE_COUNT, 1.7);
    const joinedAt = new Date(nowMinute - Math.round(age * SPAN_MINUTES + 7 + random() * 30) * 60000).toISOString();
    const earlier = rows.length ? rows[Math.floor(random() * rows.length)] : null;
    const referrer = earlier && random() < 0.38 && !earlier.name.startsWith(`${first} `) ? earlier : null;
    const answered = random() < 0.78;

    rows.push({
      id: `sample-${String(index + 1).padStart(3, "0")}`,
      email,
      name: `${first} ${initial}.`,
      status: "waiting",
      joined_at: joinedAt,
      invited_at: "",
      referral_code: `S${(index + 1).toString(36).toUpperCase().padStart(5, "0")}`,
      referred_by: referrer ? referrer.referral_code : "",
      status_token: "",
      frequency: answered ? pick(FREQUENCIES) : "",
      goal: answered ? pick(GOALS) : "",
      city: answered || random() < 0.4 ? pick(CITIES) : "",
      source: referrer ? "friend" : pick(["direct", "direct", "instagram", "newsletter", "strava-club"])
    });
  }

  // The earliest supporters already got their invites; a few people left.
  rows.slice(0, 24).forEach((row, index) => {
    if (index % 2 === 0) {
      row.status = "invited";
      row.invited_at = new Date(nowMinute - (index + 2) * 97 * 60000).toISOString();
    }
  });
  for (const index of [31, 58, 87]) rows[index].status = STATUSES[2];
  return rows;
}

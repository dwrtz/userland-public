// Demo mode for the public demo at https://link-in-bio-demo.apps.userland.fun/
//
// Your own copy of this app does NOT need this file. Demo mode only switches on
// when the request host is listed in DEMO_HOSTS, so a copy published anywhere
// else already behaves like a real app: the owner view requires an app user
// with the "owner" role. To remove demo mode completely:
//
//   1. Delete this file and tests/demo.test.ts.
//   2. In server/index.js, delete every line that ends with `// demo`.
// Keep the `demo_key` field and indexes in manifest.userland.json: every row a
// real app saves has demo_key "", and server/store.js filters on it.
//
// How the demo keeps visitors apart:
//
// - Userland passes only its own sign-in cookie to app code, so the demo can't
//   use a cookie of its own. Instead each visitor gets a random key carried in
//   the page address (?visit=...) and in a hidden form field.
// - Everything a visitor sends, and every change they make in the owner view,
//   is stored with their key. Queries always filter by key, so one visitor
//   never sees another visitor's messages, signups, or link edits.
// - Because the key is in the address, anyone who is handed that exact address
//   can open the same copy. So the demo says so on screen, points people at the
//   plain demo address for sharing, never stores a typed email address in full
//   (see privateEmail), and keeps each copy for a few hours only.
// - A new key starts with its own copy of made-up inbox items and the starter
//   links, so the owner view has something to show. Expired copies are deleted
//   when new visitors arrive.
// - With no key, the public page shows the shared starter links.

import { starterLinks, socials } from "./content.js";
import { addStarterLinks, createInboxItem, createLink, listLinks, MAX_ROWS } from "./store.js";
import { escapeHtml, layout } from "./views.js";

// The public demo's named address and the demo app's own address. Both belong
// to the Userland demo deployment only, so every page of it is marked noindex;
// replace them if you publish your own demo.
export const DEMO_HOSTS = ["link-in-bio-demo.apps.userland.fun", "7hc3cpnov6tzt3v6rdd.apps.userland.fun"];
export const EXAMPLE_PAGE_URL = "https://userland.fun/examples/link-in-bio-app/";
export const DEMO_HOME_URL = "https://link-in-bio-demo.apps.userland.fun/";

// A key is the UTC hour it was made (YYYYMMDDHH) plus 24 random hex digits.
// Keys sort oldest first, which the cleanup below relies on.
const KEY_PATTERN = /^(\d{10})-[a-f0-9]{24}$/;
const KEY_LIFETIME_HOURS = 6;
const MAX_ROWS_PER_VISITOR = 60; // stops one visitor from filling the demo
const MAX_CLEANUP_DELETES = 40;

// Returns a Demo for requests to the demo host, and null everywhere else.
export function demoMode(request) {
  const url = new URL(request.url);
  if (!DEMO_HOSTS.includes(url.hostname)) return null;
  return new Demo(url.searchParams.get("visit"));
}

class Demo {
  constructor(visit) {
    this.key = validKey(visit) ? visit : null;
  }

  // Forms carry the key in a hidden field instead of the address.
  useKeyFrom(value) {
    if (!this.key && validKey(value)) this.key = value;
  }

  get scope() {
    return this.key ?? "";
  }

  // Adds ?visit=<key> to an in-app address so the visitor keeps their copy.
  // Any old ?visit= value in `path` is replaced.
  href(path) {
    const url = new URL(path, "https://demo.invalid");
    url.searchParams.delete("visit");
    if (this.key) url.searchParams.set("visit", this.key);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  hiddenField() {
    return this.key ? `<input type="hidden" name="visit" value="${this.key}">` : "";
  }

  // Demo visitors sometimes type their real details. Email addresses that are
  // not @example.com are stored partly hidden (a•••@g•••.com), so the demo
  // never keeps a real address.
  privateDetails(values) {
    return { ...values, email: privateEmail(values.email) };
  }

  // Links for the public page: the visitor's own copy, or the shared starter links.
  async publicLinks(ctx) {
    if (this.key) return await listLinks(ctx, this.key);
    const shared = await listLinks(ctx, "");
    if (shared.length > 0) return shared;
    await addStarterLinks(ctx, "");
    return await removeDuplicateSharedLinks(ctx);
  }

  // Makes sure the visitor has a key and their own copy of the sample data.
  // Returns true when a new key was created (the caller then redirects so the
  // key shows up in the address).
  async ensureVisitor(ctx) {
    if (this.key) return false;
    this.key = newKey();
    await Promise.all([seedVisitor(ctx, this.key), deleteExpiredVisitors(ctx)]);
    return true;
  }

  // Refuses new rows once a visitor has added a lot of them.
  async isFull(ctx, collection) {
    const page = await ctx.data.collection(collection).list({ where: { demo_key: this.scope }, limit: MAX_ROWS });
    return page.rows.length >= MAX_ROWS_PER_VISITOR;
  }

  // The ribbon at the top of every demo page. In the owner view it links back
  // to the public page instead.
  ribbon({ owner = false } = {}) {
    const next = owner ? ["/", "View the public page"] : ["/admin", "Open the owner view"];
    return `<div class="demo-ribbon" role="note">
  <p><span class="demo-dot" aria-hidden="true"></span>Demo app. Built with Userland. <a href="${EXAMPLE_PAGE_URL}">See how it's made</a></p>
  <p><a class="demo-owner-link" href="${escapeHtml(this.href(next[0]))}">${next[1]} <span aria-hidden="true">&rarr;</span></a></p>
</div>`;
  }

  // Shown at the top of the owner view instead of a sign-in.
  ownerNotice() {
    return `<aside class="notice" aria-label="About this demo">
  <p><strong>This is the owner view of a demo.</strong> Sign-in is turned off so you can look around. The messages and signups are made up, plus anything you send from <a href="${escapeHtml(this.href("/"))}">the page</a>. Other visitors get their own copy and can't see yours.</p>
  <p class="notice-small">Your copy is tied to the address in your browser, so anyone you give that exact address to can open it. To show someone the demo, share <a href="${DEMO_HOME_URL}">link-in-bio-demo.apps.userland.fun</a>. Email addresses are partly hidden, and your copy is cleared after a few hours.</p>
</aside>`;
  }

  thanksNote() {
    return `<p class="thanks-demo">This is a demo, so it went to your own practice inbox. Other visitors can't see it. <a href="${escapeHtml(this.href("/admin"))}">Open the owner view <span aria-hidden="true">&rarr;</span></a></p>`;
  }

  // Shown above the public forms.
  formHint() {
    return `<p class="demo-hint">This is a demo. Made-up details work fine, like you@example.com.</p>`;
  }

  // In the demo, link buttons open this page instead of the real address.
  interstitial(target, backHref) {
    let shown = target;
    try {
      const url = new URL(target);
      shown = `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      // Keep the raw text; it is escaped below.
    }
    return layout({
      title: "Where this link goes",
      robots: "noindex,follow",
      ribbon: this.ribbon(),
      bodyClass: "page-simple",
      main: `<section class="card simple-card">
  <h1 class="simple-title">This button would open</h1>
  <p class="destination">${escapeHtml(shown)}</p>
  <p>On a real page, visitors go straight there. The owner view counts every tap, so you can see which links people use.</p>
  <p class="simple-actions"><a class="button" href="${escapeHtml(backHref)}">Back to the page</a> <a class="button button-quiet" href="${escapeHtml(this.href("/admin/links"))}">See tap counts</a></p>
</section>`
    });
  }

  socialTarget(icon) {
    return socials.find((social) => social.icon === icon)?.url ?? null;
  }
}

// Keeps the first letter of each part: alice@realmail.com -> a•••@r•••.com
export function privateEmail(email) {
  const value = String(email ?? "");
  if (/@example\.com$/i.test(value)) return value;
  const [user = "", domain = ""] = value.split("@");
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const ending = dot > 0 ? domain.slice(dot) : "";
  return `${user.slice(0, 1)}\u2022\u2022\u2022@${host.slice(0, 1)}\u2022\u2022\u2022${ending}`;
}

function validKey(value) {
  if (typeof value !== "string") return false;
  const match = KEY_PATTERN.exec(value);
  if (!match) return false;
  const age = keyAgeHours(match[1]);
  return age >= 0 && age < KEY_LIFETIME_HOURS;
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${currentHour()}-${hex}`;
}

function currentHour() {
  return new Date().toISOString().slice(0, 13).replace(/[-T]/g, "");
}

function keyAgeHours(stamp) {
  const made = Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)), Number(stamp.slice(8, 10)));
  return Math.floor((Date.now() - made) / 3_600_000);
}

// Removes rows that belong to expired keys. Keys start with their hour, so
// sorting by key puts the oldest first (after the shared rows, whose key is "").
async function deleteExpiredVisitors(ctx) {
  for (const name of ["links", "inbox"]) {
    const collection = ctx.data.collection(name);
    const page = await collection.list({ order_by: [{ field: "demo_key", direction: "asc" }], limit: MAX_ROWS });
    const expired = page.rows
      .filter((row) => {
        const match = KEY_PATTERN.exec(String(row.demo_key ?? ""));
        return match && keyAgeHours(match[1]) >= KEY_LIFETIME_HOURS;
      })
      .slice(0, MAX_CLEANUP_DELETES);
    await Promise.all(expired.map((row) => collection.delete(row.id)));
  }
}

// If two first visits arrive at the same moment, both may add the shared
// starter links. Keep the oldest copy of each link and delete the rest.
async function removeDuplicateSharedLinks(ctx) {
  const links = await listLinks(ctx, "");
  const kept = [];
  const seen = new Set();
  const extra = [];
  for (const link of [...links].sort((a, b) => String(a.created_at ?? a.id).localeCompare(String(b.created_at ?? b.id)))) {
    const slot = `${link.title}\n${link.url}`;
    if (seen.has(slot)) extra.push(link);
    else {
      seen.add(slot);
      kept.push(link);
    }
  }
  await Promise.all(extra.map((link) => ctx.data.collection("links").delete(link.id)));
  return kept.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

async function seedVisitor(ctx, key) {
  const now = Date.now();
  const hoursAgo = (hours) => new Date(now - hours * 3_600_000).toISOString();
  await Promise.all([
    ...starterLinks.map((link, index) => createLink(ctx, key, { ...link, clicks: SAMPLE_CLICKS[index] ?? 0 }, index + 1)),
    ...SAMPLE_MESSAGES.map((item) => createInboxItem(ctx, key, { ...item, kind: "message", received_at: hoursAgo(item.hoursAgo) })),
    ...SAMPLE_SIGNUPS.map((item) => createInboxItem(ctx, key, { ...item, kind: "signup", received_at: hoursAgo(item.hoursAgo) }))
  ]);
}

// Made-up sample data. Every address uses example.com.
const SAMPLE_CLICKS = [212, 148, 97, 331, 86, 64, 120, 23];

const SAMPLE_MESSAGES = [
  {
    name: "Priya Raman",
    email: "priya@example.com",
    topic: "Wholesale",
    message: "Hi Wren! We run a small cafe and would love 24 mugs with our logo stamped on the bottom. Is that something you do, and what's the lead time?",
    status: "new",
    hoursAgo: 3
  },
  {
    name: "Theo Marsh",
    email: "theo.marsh@example.com",
    topic: "Workshop",
    message: "Is the Saturday workshop okay for a total beginner? I'm thinking of booking a seat for my partner's birthday.",
    status: "new",
    hoursAgo: 20
  },
  {
    name: "Dana Whitfield",
    email: "dana@example.com",
    topic: "Collab",
    message: "I host a baking podcast and would love to have you on to talk ceramic pie dishes versus metal tins. Any interest?",
    status: "replied",
    hoursAgo: 52
  },
  {
    name: "Luis Ortega",
    email: "luis@example.com",
    topic: "Order question",
    message: "My pie dish arrived with a small chip on the rim. Could I swap it for one from the next drop?",
    status: "replied",
    hoursAgo: 75
  }
];

const SAMPLE_SIGNUPS = [
  { name: "Maya Kim", email: "maya.k@example.com", hoursAgo: 1 },
  { name: "", email: "jordan@example.com", hoursAgo: 6 },
  { name: "Sam Lee", email: "sam.lee@example.com", hoursAgo: 26 },
  { name: "Hollis Grant", email: "hollis@example.com", hoursAgo: 40 },
  { name: "Bea Torres", email: "bea.t@example.com", hoursAgo: 71 }
];

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
//   use a cookie of its own. Instead each visitor gets a key carried in the
//   page address (?visit=...) and in a hidden form field.
// - Everything a visitor sends, and every change they make in the owner view,
//   is stored with their key. Queries always filter by key, so one visitor
//   never sees another visitor's messages, signups, or link edits.
// - Keys are handed out by the demo, never made up: each one has a small
//   "visitor" row in the inbox collection (slot visitors/<hour>/<number>), and
//   a key without one is ignored. Each hour has VISITORS_PER_HOUR numbers, so
//   the demo says "busy" instead of filling up. Link checkers, scripts, and
//   other requests that don't look like a person's browser don't get a copy.
//   (A script can pretend to be a browser, so it can still use up an hour's
//   copies; new visitors then see the "busy" page until the next hour.)
// - Because the key is in the address, anyone who is handed that exact address
//   can open the same copy. So a key only counts when the visitor got there
//   from the demo itself (a link to someone's copy posted on another site opens
//   a fresh copy instead), the demo says so on screen, points people at the
//   plain demo address for sharing, labels every page of a copy as a
//   visitor's practice copy, never stores a typed email address in full (see
//   privateEmail), and keeps each copy for a few hours only.
// - A new key starts with its own copy of made-up inbox items and the starter
//   links, so the owner view has something to show. Expired copies are deleted
//   when new visitors arrive.
// - With no key, the public page shows the shared starter links.

import { starterLinks, socials } from "./content.js";
import { addStarterLinks, claimSlot, createInboxItem, createLink, listLinks, MAX_ROWS, pause, signupSlot, starterSlot } from "./store.js";
import { escapeHtml, layout } from "./views.js";

// The public demo's named address and the demo app's own address. Both belong
// to the Userland demo deployment only, so every page of it is marked noindex;
// replace them if you publish your own demo.
export const DEMO_HOSTS = ["link-in-bio-demo.apps.userland.fun", "7hc3cpnov6tzt3v6rdd.apps.userland.fun"];
export const EXAMPLE_PAGE_URL = "https://userland.fun/examples/link-in-bio-app/";
export const DEMO_HOME_URL = "https://link-in-bio-demo.apps.userland.fun/";

// A key is the UTC hour it was made (YYYYMMDDHH), the visitor's number in that
// hour, and 24 random hex digits. Keys sort oldest hour first, which the
// cleanup below relies on. (Keys from older versions have no number; the
// cleanup still recognizes them, but they no longer open a copy.)
const KEY_PATTERN = /^(\d{10})-(?:(\d{4})-)?[a-f0-9]{24}$/;
const KEY_LIFETIME_HOURS = 6;
const VISITORS_PER_HOUR = 50; // new copies per hour before the demo says it's busy
const MAX_ROWS_PER_VISITOR = 60; // stops one visitor from filling the demo
const MAX_CLEANUP_DELETES = 25;
const ISSUE_TRIES = 12;

// Returns a Demo for requests to the demo host, and null everywhere else.
export function demoMode(request) {
  const url = new URL(request.url);
  if (!DEMO_HOSTS.includes(url.hostname)) return null;
  return new Demo(request, url);
}

class Demo {
  constructor(request, url) {
    this.key = null;
    this.checked = false;
    // A key is only honored when the request comes from the demo's own pages
    // (or is typed in). A link to someone's copy posted on another site, or a
    // form on another site, starts a fresh copy instead, so nobody can dress up
    // a copy and send people to it.
    this.trusted = fromThisSite(request, url);
    this.candidate = this.trusted ? url.searchParams.get("visit") : null;
  }

  // Picks up the visitor's key from the address, or from a form's hidden
  // field, and checks that the demo handed it out. Safe to call more than once.
  async useKey(ctx, formValue) {
    if (this.key || this.checked) return;
    this.checked = true;
    const value = this.trusted && validKey(formValue) ? formValue : this.candidate;
    if (validKey(value) && (await isIssued(ctx, value))) this.key = value;
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
    // Starter links have fixed slots, so simultaneous first visits add them once.
    await addStarterLinks(ctx, "");
    return await listLinks(ctx, "");
  }

  // Makes sure the visitor has a key and their own copy of the sample data.
  // Returns "existing" when they already had one, "new" when a key was just
  // handed out (the caller then redirects so the key shows up in the address),
  // or "busy" when (nearly) all of this hour's VISITORS_PER_HOUR keys are out.
  // With seed: false (a HEAD request, or a link checker or script) it writes
  // nothing and the address it redirects to won't open a copy.
  async ensureVisitor(ctx, { seed = true } = {}) {
    if (this.key) return "existing";
    if (!seed) {
      this.key = `${currentHour()}-0000-${randomHex()}`;
      return "new";
    }
    const key = await issueKey(ctx);
    if (!key) return "busy";
    this.key = key;
    await Promise.all([seedVisitor(ctx, key), deleteExpiredVisitors(ctx)]);
    return "new";
  }

  // Refuses new rows once a visitor has added a lot of them. `adding` is how
  // many rows the caller is about to add.
  async isFull(ctx, collection, adding = 1) {
    const page = await ctx.data.collection(collection).list({ where: { demo_key: this.scope }, limit: MAX_ROWS });
    return page.rows.length + adding > MAX_ROWS_PER_VISITOR;
  }

  // The ribbon at the top of every demo page. In the owner view it links back
  // to the public page instead. Links carry rel="nofollow" (and robots.txt
  // turns crawlers away from /admin) so search engines don't open copies.
  ribbon({ owner = false } = {}) {
    const next = owner ? ["/", "View the public page"] : ["/admin", "Open the owner view"];
    // A visitor's copy says so on every page, so a copy someone dressed up and
    // sent around doesn't pass for the real demo.
    const copy = this.key ? " This is a visitor's practice copy." : "";
    return `<div class="demo-ribbon" role="note">
  <p><span class="demo-dot" aria-hidden="true"></span>Demo app. Built with Userland.${copy} <a href="${EXAMPLE_PAGE_URL}">See how it's made</a></p>
  <p><a class="demo-owner-link" href="${escapeHtml(this.href(next[0]))}" rel="nofollow">${next[1]} <span aria-hidden="true">&rarr;</span></a></p>
</div>`;
  }

  // Shown at the top of the owner view instead of a sign-in.
  ownerNotice() {
    return `<aside class="notice" aria-label="About this demo">
  <p><strong>This is the owner view of a demo.</strong> Sign-in is turned off so you can look around. The messages and signups are made up, plus anything you send from <a href="${escapeHtml(this.href("/"))}" rel="nofollow">the page</a>. Other visitors get their own copy and can't see yours.</p>
  <p class="notice-small">Your copy is tied to the address in your browser, so anyone you give that exact address to can open it. To show someone the demo, share <a href="${DEMO_HOME_URL}">link-in-bio-demo.apps.userland.fun</a>. Email addresses are partly hidden, and your copy is cleared after a few hours.</p>
</aside>`;
  }

  thanksNote() {
    return `<p class="thanks-demo">This is a demo, so it went to your own practice inbox. Other visitors can't see it. <a href="${escapeHtml(this.href("/admin"))}" rel="nofollow">Open the owner view <span aria-hidden="true">&rarr;</span></a></p>`;
  }

  // Shown above the public forms.
  formHint() {
    const shared = this.key ? " What you send goes to a practice copy that anyone with this page's exact address can open, including whoever gave you the address." : "";
    return `<p class="demo-hint">This is a demo. Made-up details work fine, like you@example.com.${shared}</p>`;
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
  <p class="simple-actions"><a class="button" href="${escapeHtml(backHref)}">Back to the page</a> <a class="button button-quiet" href="${escapeHtml(this.href("/admin/links"))}" rel="nofollow">See tap counts</a></p>
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

// True when the request comes from the demo's own pages or was typed in.
// Browsers send Sec-Fetch-Site on page loads and Origin on form posts.
function fromThisSite(request, url) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}

function validKey(value) {
  if (typeof value !== "string") return false;
  const match = KEY_PATTERN.exec(value);
  if (!match || !match[2]) return false;
  const age = keyAgeHours(match[1]);
  return age >= 0 && age < KEY_LIFETIME_HOURS;
}

function visitorSlot(hour, number) {
  return `visitors/${hour}/${number}`;
}

// A key counts only if the demo handed it out: its visitor row must exist.
async function isIssued(ctx, key) {
  const [, hour, number] = KEY_PATTERN.exec(key);
  const page = await ctx.data.collection("inbox").list({ where: { slot: visitorSlot(hour, number) }, limit: 1 });
  return page.rows[0]?.demo_key === key;
}

// Hands out a visitor number for this hour by claiming its visitor row. It
// tries up to ISSUE_TRIES different numbers from 1 to VISITORS_PER_HOUR in a
// random order, so visitors arriving together rarely collide. Returns null
// (busy) when every number it tried is taken, which only happens when nearly
// all of this hour's numbers are.
async function issueKey(ctx) {
  const hour = currentHour();
  const numbers = Array.from({ length: VISITORS_PER_HOUR }, (_, index) => index + 1);
  for (let attempt = 0; attempt < Math.min(ISSUE_TRIES, VISITORS_PER_HOUR); attempt += 1) {
    if (attempt > 0) await pause(attempt);
    // Picks one of the numbers not tried yet.
    const pick = attempt + Math.floor(Math.random() * (numbers.length - attempt));
    [numbers[attempt], numbers[pick]] = [numbers[pick], numbers[attempt]];
    const number = String(numbers[attempt]).padStart(4, "0");
    const key = `${hour}-${number}-${randomHex()}`;
    const saved = await claimSlot(ctx, "inbox", { demo_key: key, slot: visitorSlot(hour, number), received_at: new Date().toISOString() });
    if (saved) return key;
  }
  return null;
}

function randomHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentHour() {
  return new Date().toISOString().slice(0, 13).replace(/[-T]/g, "");
}

function keyAgeHours(stamp) {
  const made = Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)), Number(stamp.slice(8, 10)));
  return Math.floor((Date.now() - made) / 3_600_000);
}

// Removes rows that belong to expired keys (their links, tap tallies, inbox
// items, and visitor row). Keys start with their hour, so sorting by key puts
// the oldest first (after the shared rows, whose key is "").
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

async function seedVisitor(ctx, key) {
  const now = Date.now();
  const hoursAgo = (hours) => new Date(now - hours * 3_600_000).toISOString();
  await Promise.all([
    ...starterLinks.map((link, index) => createLink(ctx, key, { ...link, clicks: SAMPLE_CLICKS[index] ?? 0 }, index + 1, starterSlot(key, index + 1))),
    ...SAMPLE_MESSAGES.map((item) => createInboxItem(ctx, key, { ...item, kind: "message", received_at: hoursAgo(item.hoursAgo) })),
    ...SAMPLE_SIGNUPS.map((item) => createInboxItem(ctx, key, { ...item, kind: "signup", received_at: hoursAgo(item.hoursAgo), slot: signupSlot(key, item.email) }))
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

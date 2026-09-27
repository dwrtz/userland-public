import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { toCsv } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { EXPORT_PAGES, MAX_NEW_MESSAGES, MESSAGES_PER_PAGE, NOTES_PER_ADDRESS_PER_DAY, SIGNUPS_PER_DAY, claimSlot, recordTap } from "../server/store.js";
import { APP, BROWSER, Ctx, DEMO, FAN_COOKIE, OWNER_COOKIE, Row, addStarterLinks, get, makeCtx, post, type Server } from "./helpers.js";

const owner = { cookie: OWNER_COOKIE };

async function ownerPage(ctx: Ctx, pathAndQuery: string) {
  const res = await get(ctx, `${APP}${pathAndQuery}`, owner);
  expect(res.status).toBe(200);
  return await res.text();
}

// The tap count the owner sees for a link.
async function tapsShown(ctx: Ctx, title: string) {
  const html = await ownerPage(ctx, "/admin/links");
  const row = html.split('<li class="manage-row').find((part) => part.includes(`${title} `))!;
  return Number(/manage-meta">(\d+) taps?\b/.exec(row)![1]);
}

async function addRows(ctx: Ctx, name: string, rows: Row[]) {
  for (const row of rows) await ctx.data.collection(name).create(row);
}

function inboxRow(overrides: Row): Row {
  return { kind: "message", name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "Hi", status: "new", received_at: new Date().toISOString(), demo_key: "", ...overrides };
}

describe("saving rows with a unique slot", () => {
  // The test ctx works like Userland: a row and its unique values are saved
  // together, so of two creates with the same value that arrive at the same
  // moment one is kept and the other fails with unique_conflict, saving nothing.
  it("the test ctx refuses a simultaneous duplicate cleanly, like Userland", async () => {
    const ctx = makeCtx();
    const inbox = ctx.data.collection("inbox");
    const results = await Promise.allSettled([1, 2].map(() => inbox.create({ demo_key: "", slot: "race" })));
    const failed = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe("unique_conflict");
    expect(ctx.state.visitors).toHaveLength(1);
  });

  it("claimSlot gives the slot to exactly one of many simultaneous saves", async () => {
    const ctx = makeCtx();
    const results = await Promise.all(Array.from({ length: 8 }, () => claimSlot(ctx, "inbox", { demo_key: "", slot: "race" })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(ctx.state.visitors).toHaveLength(1);
    expect(await claimSlot(ctx, "inbox", { demo_key: "", slot: "race" })).toBeNull();
  });

  it("claimSlot passes on errors that aren't about the slot", async () => {
    const ctx = makeCtx({ maxRows: 0 });
    await expect(claimSlot(ctx, "inbox", { demo_key: "", slot: "full" })).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("recordTap counts simultaneous taps without errors or leftover rows", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const counts = await Promise.all(Array.from({ length: 5 }, () => recordTap(ctx, link)));
    expect([...counts].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(ctx.state.tallies).toHaveLength(1);
  });
});

describe("public page", () => {
  it("shows the profile, featured products, and visible links in order", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const hidden = ctx.state.links.find((l) => l.title === "Wholesale and cafe orders")!;
    await ctx.data.collection("links").update(hidden.id, { visible: false });

    const res = await get(ctx, `${APP}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Kiln &amp; Crumb");
    expect(html).toContain("Fresh from the kiln");
    expect(html.indexOf("Speckled Pie Dish")).toBeLessThan(html.indexOf("Morning Mugs"));
    expect(html).not.toContain("Wholesale and cafe orders");
    // A normal copy of the app is indexable and has no demo ribbon.
    expect(html).not.toContain('name="robots"');
    expect(html).not.toContain("Demo app");
    // Crawlers are asked not to follow the tap-counting addresses.
    expect(html).toMatch(/href="\/go\/[^"]+" rel="nofollow"/);
    expect(html).not.toMatch(/href="\/go\/[^"]+">/);
  });

  it("ships a robots.txt that keeps crawlers off /go/ and /admin", () => {
    const robots = fs.readFileSync(path.resolve(import.meta.dirname, "../public/robots.txt"), "utf8");
    expect(robots).toContain("Disallow: /go/");
    expect(robots).toContain("Disallow: /admin");
  });

  it("escapes link text so owners can't break the page", async () => {
    const ctx = makeCtx();
    await ctx.data.collection("links").create({ title: '<script>alert("x")</script>', url: "https://example.com", note: "", price: "", picture: "mug", featured: false, visible: true, position: 1, clicks: 0, demo_key: "" });
    const html = await (await get(ctx, `${APP}/`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("counts a tap and redirects to the link", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const res = await get(ctx, `${APP}/go/${link.id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.url);
    expect(await tapsShown(ctx, link.title)).toBe(1);
    await get(ctx, `${APP}/go/${link.id}`);
    expect(await tapsShown(ctx, link.title)).toBe(2);
    // The count lives in one small tally row, never on the link itself.
    expect(ctx.state.tallies).toHaveLength(1);
    expect(ctx.state.links[0]).toMatchObject({ clicks: 0, updated_at: link.updated_at });
  });

  it("counts every one of several taps that arrive at the same moment", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const responses = await Promise.all(Array.from({ length: 6 }, () => get(ctx, `${APP}/go/${link.id}`)));
    expect(responses.map((res) => res.status)).toEqual(Array(6).fill(302));
    expect(await tapsShown(ctx, link.title)).toBe(6);
    expect(ctx.state.tallies.filter((row) => row.slot.includes(link.id))).toHaveLength(1);
    expect(ctx.log.error).not.toHaveBeenCalled();
  });

  it("never lets a tap undo a change the owner is saving", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const save = post(ctx, `${APP}/admin/links/${link.id}`, { action: "save", title: "Renamed dish", url: "https://shop.example.com/renamed", picture: "pie-dish", visible: "yes", featured: "yes" }, owner);
    const taps = Array.from({ length: 3 }, () => get(ctx, `${APP}/go/${link.id}`));
    await Promise.all([save, ...taps]);
    expect(ctx.state.links.find((row) => row.id === link.id)).toMatchObject({ title: "Renamed dish", url: "https://shop.example.com/renamed" });
    expect(await tapsShown(ctx, "Renamed dish")).toBe(3);
  });

  it("starts from taps counted by older versions of the app", async () => {
    const ctx = makeCtx();
    await ctx.data.collection("links").create({ title: "Old link", url: "https://example.com/old", visible: true, position: 1, clicks: 41, demo_key: "" });
    const link = ctx.state.links[0];
    await get(ctx, `${APP}/go/${link.id}`);
    expect(await tapsShown(ctx, "Old link")).toBe(42);
  });

  it("doesn't count search engines, link previews, or browser prefetches as taps", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const visitors: Array<Record<string, string | null>> = [
      { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
      { "user-agent": "facebookexternalhit/1.1" },
      { "user-agent": null },
      { "sec-purpose": "prefetch" },
      { purpose: "prefetch" }
    ];
    for (const headers of visitors) {
      const res = await get(ctx, `${APP}/go/${link.id}`, headers);
      expect(res.status).toBe(302);
    }
    expect(ctx.state.tallies).toHaveLength(0);
    expect(await ownerPage(ctx, "/admin/links")).toContain("good guide rather than an exact tally");
  });

  it("still sends the visitor on when a tap can't be saved", async () => {
    const full = makeCtx({ maxRows: 8 });
    await addStarterLinks(full);
    const link = full.state.links[0];
    const res = await get(full, `${APP}/go/${link.id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.url);
  });
});

describe("HEAD requests", () => {
  it("answer every page like GET, without a body", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const pages: Array<[string, number, Record<string, string>?]> = [
      [`${APP}/`, 200],
      [`${APP}/contact`, 200],
      [`${APP}/thanks?kind=list`, 200],
      [`${APP}/admin`, 303],
      [`${APP}/admin`, 200, owner],
      [`${APP}/admin?tab=list`, 200, owner],
      [`${APP}/admin/links`, 200, owner],
      [`${APP}/admin/email-list.csv`, 200, owner],
      [`${APP}/missing`, 404],
      [`${DEMO}/`, 200]
    ];
    for (const [url, status, headers] of pages) {
      expect((await expectHeadLikeGet(app, ctx, url, { headers })).status).toBe(status);
    }
  });

  it("don't count as a tap on a link", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const res = await app.fetch(new Request(`${APP}/go/${link.id}`, { method: "HEAD", headers: { "user-agent": BROWSER } }), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.url);
    expect(ctx.state.tallies).toHaveLength(0);
    expect((await expectHeadLikeGet(app, ctx, `${APP}/go/${link.id}`, { headers: { "user-agent": BROWSER } })).status).toBe(302);
    expect(await tapsShown(ctx, link.title)).toBe(1);
  });
});

describe("email list", () => {
  it("adds a signup once per address", async () => {
    const ctx = makeCtx();
    const first = await post(ctx, `${APP}/subscribe`, { name: "Ada", email: "ada@example.com" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/thanks?kind=signup");
    const again = await post(ctx, `${APP}/subscribe`, { email: "ADA@example.com" });
    expect(again.headers.get("location")).toBe("/thanks?kind=signup");
    expect(ctx.state.inbox).toHaveLength(1);
    expect(ctx.state.inbox[0]).toMatchObject({ kind: "signup", email: "ada@example.com", status: "new", demo_key: "" });
  });

  it("adds one row when the same address signs up several times at once", async () => {
    const ctx = makeCtx();
    const responses = await Promise.all(["ada@example.com", "Ada@example.com", "ADA@EXAMPLE.COM", "ada@example.com", "ada@Example.com"].map((email) => post(ctx, `${APP}/subscribe`, { email })));
    expect(responses.map((res) => res.status)).toEqual(Array(5).fill(303));
    expect(ctx.state.inbox).toHaveLength(1);
  });

  it("keeps a removed address off the list when anyone signs it up again", async () => {
    const ctx = makeCtx();
    await post(ctx, `${APP}/subscribe`, { email: "gone@example.com" });
    const [row] = ctx.state.inbox;
    expect((await post(ctx, `${APP}/admin/inbox/${row.id}`, { status: "archived", tab: "list" }, owner)).status).toBe(303);
    const again = await post(ctx, `${APP}/subscribe`, { email: "Gone@example.com" });
    expect(again.headers.get("location")).toBe("/thanks?kind=signup");
    expect(ctx.state.inbox).toHaveLength(1);
    expect(ctx.state.inbox[0].status).toBe("archived");
    const csv = await (await get(ctx, `${APP}/admin/email-list.csv`, owner)).text();
    expect(csv).not.toContain("gone@example.com");
    // The owner can still put them back.
    const archived = await ownerPage(ctx, "/admin?tab=archived");
    expect(archived).toContain("Removed from list");
    expect(archived).toContain("Put back on list");
    await post(ctx, `${APP}/admin/inbox/${row.id}`, { status: "new", tab: "archived" }, owner);
    expect(ctx.state.inbox[0].status).toBe("new");
  });

  it("tells the owner the list is unconfirmed", async () => {
    const ctx = makeCtx();
    expect(await ownerPage(ctx, "/admin?tab=list")).toContain("double opt-in");
  });

  it("pauses signups for the day after a burst, with a friendly page", async () => {
    const ctx = makeCtx();
    const now = Date.now();
    // Yesterday's signups don't count toward today's limit.
    await addRows(ctx, "inbox", [inboxRow({ kind: "signup", email: "old@example.com", received_at: new Date(now - 25 * 3_600_000).toISOString() })]);
    await addRows(ctx, "inbox", Array.from({ length: SIGNUPS_PER_DAY - 1 }, (_, i) => inboxRow({ kind: "signup", email: `fan${i}@example.com`, received_at: new Date(now - i * 60_000).toISOString() })));
    expect((await post(ctx, `${APP}/subscribe`, { email: "last@example.com" })).status).toBe(303);
    const busy = await post(ctx, `${APP}/subscribe`, { email: "one-too-many@example.com" });
    expect(busy.status).toBe(429);
    expect(await busy.text()).toContain("The list is extra busy today");
    expect(ctx.state.inbox.some((row) => row.email === "one-too-many@example.com")).toBe(false);
  });

  it("counts the daily signup limit exactly, with no older signups to stop at", async () => {
    const ctx = makeCtx();
    const now = Date.now();
    await addRows(ctx, "inbox", Array.from({ length: SIGNUPS_PER_DAY - 1 }, (_, i) => inboxRow({ kind: "signup", email: `fan${i}@example.com`, received_at: new Date(now - i * 60_000).toISOString() })));
    expect((await post(ctx, `${APP}/subscribe`, { email: "last@example.com" })).status).toBe(303);
    expect((await post(ctx, `${APP}/subscribe`, { email: "one-too-many@example.com" })).status).toBe(429);
    expect(ctx.state.inbox).toHaveLength(SIGNUPS_PER_DAY);
  });

  it("holds the daily signup limit when a burst arrives all at once", async () => {
    const ctx = makeCtx();
    const now = Date.now();
    await addRows(ctx, "inbox", Array.from({ length: SIGNUPS_PER_DAY - 10 }, (_, i) => inboxRow({ kind: "signup", email: `fan${i}@example.com`, received_at: new Date(now - i * 60_000).toISOString() })));
    const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => post(ctx, `${APP}/subscribe`, { email: `burst${i}@example.com` })));
    expect(responses.every((res) => [303, 429].includes(res.status))).toBe(true);
    const kept = ctx.state.inbox.filter((row) => row.email.startsWith("burst"));
    expect(kept.length).toBeLessThanOrEqual(10);
    expect(responses.filter((res) => res.status === 303)).toHaveLength(kept.length);
    expect(ctx.state.inbox.length).toBeLessThanOrEqual(SIGNUPS_PER_DAY);
    // Once the burst is over, the form works again for the room that's left.
    if (kept.length < 10) expect((await post(ctx, `${APP}/subscribe`, { email: "after@example.com" })).status).toBe(303);
  });

  it("rejects a bad email and keeps what the visitor typed", async () => {
    const ctx = makeCtx();
    const res = await post(ctx, `${APP}/subscribe`, { name: "Ada", email: "not-an-email" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('value="not-an-email"');
    expect(ctx.state.inbox).toHaveLength(0);
  });
});

describe("contact form", () => {
  it("rejects addresses that would add fields to the owner's reply email", async () => {
    const ctx = makeCtx();
    for (const email of ["x@y.com?bcc=evil%40ex.com", "x@y.com&cc=a@b.com", "x@y.com#frag", "x%40y@z.com"]) {
      const res = await post(ctx, `${APP}/contact`, { name: "Ada", email, topic: "Wholesale", message: "Hi" });
      expect(res.status).toBe(422);
    }
    expect(ctx.state.inbox).toHaveLength(0);

    await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada.o'neil+shop@mail.example.co.uk", topic: "Wholesale", message: "Hi" });
    const inbox = await ownerPage(ctx, "/admin");
    expect(inbox).toContain('href="mailto:ada.o&#39;neil+shop@mail.example.co.uk?subject=');
  });

  it("quietly ignores bots that fill in the hidden field", async () => {
    const ctx = makeCtx();
    const res = await post(ctx, `${APP}/contact`, { name: "Bot", email: "bot@example.com", topic: "Wholesale", message: "Buy now", website: "https://spam.example" });
    expect(res.status).toBe(303);
    expect(ctx.state.inbox).toHaveLength(0);
  });

  it("stores a contact message and validates length and topic", async () => {
    const ctx = makeCtx();
    const tooLong = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "x".repeat(2001) });
    expect(tooLong.status).toBe(422);
    const badTopic = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Crypto", message: "Hello" });
    expect(badTopic.status).toBe(422);
    const ok = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "Hello <b>Wren</b>" });
    expect(ok.status).toBe(303);
    expect(ctx.state.inbox[0]).toMatchObject({ kind: "message", topic: "Wholesale", message: "Hello <b>Wren</b>" });

    const inbox = await ownerPage(ctx, "/admin");
    expect(inbox).toContain("Hello &lt;b&gt;Wren&lt;/b&gt;");
  });

  it("limits how many notes one address can send in a day, even all at once", async () => {
    const ctx = makeCtx();
    const note = (email: string) => post(ctx, `${APP}/contact`, { name: "Ada", email, topic: "Collab", message: "Hello again" });
    const responses = await Promise.all(Array.from({ length: NOTES_PER_ADDRESS_PER_DAY + 2 }, (_, i) => note(i % 2 ? "ADA@example.com" : "ada@example.com")));
    expect(responses.filter((res) => res.status === 303)).toHaveLength(NOTES_PER_ADDRESS_PER_DAY);
    const refused = responses.find((res) => res.status === 429)!;
    expect(await refused.text()).toContain("You&#39;ve sent a few notes today");
    expect(ctx.state.inbox).toHaveLength(NOTES_PER_ADDRESS_PER_DAY);
    // Someone else can still write.
    expect((await note("grace@example.com")).status).toBe(303);
  });

  it("pauses the form once the inbox holds a lot of unread messages", async () => {
    const ctx = makeCtx();
    await addRows(ctx, "inbox", Array.from({ length: MAX_NEW_MESSAGES }, (_, i) => inboxRow({ email: `sender${i}@example.com` })));
    const full = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Collab", message: "Hi" });
    expect(full.status).toBe(429);
    expect(await full.text()).toContain("Wren&#39;s inbox is full right now");
    // Archiving a batch opens it up again.
    await post(ctx, `${APP}/admin/inbox`, { action: "archive-new", confirm: "yes" }, owner);
    expect((await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Collab", message: "Hi" })).status).toBe(303);
  });

  it("holds the unread-message limit when a burst arrives all at once", async () => {
    const ctx = makeCtx();
    await addRows(ctx, "inbox", Array.from({ length: MAX_NEW_MESSAGES - 5 }, (_, i) => inboxRow({ email: `sender${i}@example.com` })));
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => post(ctx, `${APP}/contact`, { name: "Bot", email: `bot${i}@example.com`, topic: "Collab", message: "Hello there" })));
    expect(responses.every((res) => [303, 429].includes(res.status))).toBe(true);
    const unread = ctx.state.inbox.filter((row) => row.kind === "message" && row.status === "new");
    expect(unread.length).toBeLessThanOrEqual(MAX_NEW_MESSAGES);
    expect(responses.filter((res) => res.status === 303)).toHaveLength(unread.length - (MAX_NEW_MESSAGES - 5));
  });

  it("shows a clear page instead of an error when the plan's space is full", async () => {
    const ctx = makeCtx({ maxRows: 0 });
    const signup = await post(ctx, `${APP}/subscribe`, { email: "ada@example.com" });
    expect(signup.status).toBe(503);
    expect(await signup.text()).toContain("This page is full for now");
    const message = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Collab", message: "Hi" });
    expect(message.status).toBe(503);
    const add = await post(ctx, `${APP}/admin/links`, { title: "New mug", url: "https://shop.example.com/mug", visible: "yes" }, owner);
    expect(add.status).toBe(503);
    expect(await add.text()).toContain("Delete archived messages and removed signups to make room");
  });
});

describe("owner view outside the demo", () => {
  it("sends signed-out visitors to sign in", async () => {
    const ctx = makeCtx();
    const res = await get(ctx, `${APP}/admin/links`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin%2Flinks");
  });

  it("refuses signed-out changes", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const res = await post(ctx, `${APP}/admin/links/${link.id}`, { action: "delete" });
    expect(res.status).toBe(401);
    const csv = await get(ctx, `${APP}/admin/email-list.csv`);
    expect(csv.status).toBe(303);
    expect(ctx.state.links).toHaveLength(8);
  });

  it("refuses app users without the owner role", async () => {
    const ctx = makeCtx();
    const res = await get(ctx, `${APP}/admin`, { cookie: FAN_COOKIE });
    expect(res.status).toBe(403);
    const change = await post(ctx, `${APP}/admin/links/starter`, {}, { cookie: FAN_COOKIE });
    expect(change.status).toBe(403);
    expect(ctx.state.links).toHaveLength(0);
  });

  it("refuses changes that don't come from the app's own pages, even with an owner session", async () => {
    const ctx = makeCtx();
    const foreign: Array<Record<string, string | null>> = [
      { origin: "https://evil.example" },
      { origin: "https://other-app.apps.userland.fun" },
      { origin: "null" },
      { origin: null },
      { origin: null, "sec-fetch-site": "same-site" }
    ];
    for (const headers of foreign) {
      const res = await post(ctx, `${APP}/admin/links/starter`, {}, { ...owner, ...headers });
      expect(res.status).toBe(403);
    }
    expect(ctx.state.links).toHaveLength(0);
    // A browser that leaves out Origin but says the post is same-origin is fine.
    expect((await post(ctx, `${APP}/admin/links/starter`, {}, { ...owner, origin: null, "sec-fetch-site": "same-origin" })).status).toBe(303);
  });

  it("lets the owner manage links and the inbox", async () => {
    const ctx = makeCtx();
    const add = await post(ctx, `${APP}/admin/links`, { title: "New mug", url: "https://shop.example.com/mug", picture: "mug", featured: "yes", visible: "yes", price: "$30" }, owner);
    expect(add.status).toBe(303);
    const bad = await post(ctx, `${APP}/admin/links`, { title: "Bad", url: "javascript:alert(1)" }, owner);
    expect(bad.status).toBe(422);
    expect(ctx.state.links).toHaveLength(1);

    const id = ctx.state.links[0].id;
    await post(ctx, `${APP}/admin/links/${id}`, { action: "hide" }, owner);
    expect(ctx.state.links[0].visible).toBe(false);
    await post(ctx, `${APP}/admin/links/${id}`, { action: "save", title: "Renamed mug", url: "https://shop.example.com/mug2", picture: "mug", visible: "yes" }, owner);
    expect(ctx.state.links[0]).toMatchObject({ title: "Renamed mug", visible: true, featured: false });

    await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "Hi" });
    const message = ctx.state.inbox[0];
    const status = await post(ctx, `${APP}/admin/inbox/${message.id}`, { status: "replied" }, owner);
    expect(status.status).toBe(303);
    expect(ctx.state.inbox[0].status).toBe("replied");
    expect(await ownerPage(ctx, "/admin?tab=replied")).toContain("ada@example.com");

    await get(ctx, `${APP}/go/${id}`);
    expect(ctx.state.tallies).toHaveLength(1);
    await post(ctx, `${APP}/admin/links/${id}`, { action: "delete" }, owner);
    expect(ctx.state.links).toHaveLength(0);
    expect(ctx.state.tallies).toHaveLength(0);
  });

  it("adds the starter links once, even on a double-click", async () => {
    const ctx = makeCtx();
    const clicks = await Promise.all([1, 2, 3].map(() => post(ctx, `${APP}/admin/links/starter`, {}, owner)));
    expect(clicks.map((res) => res.status)).toEqual([303, 303, 303]);
    expect(ctx.state.links).toHaveLength(8);
    expect(new Set(ctx.state.links.map((link) => link.title)).size).toBe(8);
  });

  it("moves links up and down", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const second = ctx.state.links.find((l) => l.position === 2)!;
    await post(ctx, `${APP}/admin/links/${second.id}`, { action: "up" }, owner);
    const html = await (await get(ctx, `${APP}/`)).text();
    expect(html.indexOf("Morning Mugs")).toBeLessThan(html.indexOf("Speckled Pie Dish"));
  });

  it("shows the inbox a page at a time, newest first", async () => {
    const ctx = makeCtx();
    const now = Date.now();
    const total = MESSAGES_PER_PAGE + 5;
    await addRows(ctx, "inbox", Array.from({ length: total }, (_, i) => inboxRow({ name: `Sender ${String(i).padStart(2, "0")}`, received_at: new Date(now - i * 60_000).toISOString() })));
    const first = await ownerPage(ctx, "/admin");
    expect(first).toContain("Sender 00");
    expect(first).not.toContain(`Sender ${String(total - 1).padStart(2, "0")}`);
    expect(first).toContain(`<span class="count">${total}</span>`);
    const older = /href="(\/admin\?tab=messages&amp;cursor=[^"]+)"/.exec(first)![1].replaceAll("&amp;", "&");
    const second = await ownerPage(ctx, older);
    expect(second).toContain(`Sender ${String(total - 1).padStart(2, "0")}`);
    expect(second).not.toContain("Sender 00<");
    expect(second).toContain("Back to newest");
    // Every message shows up on exactly one page.
    const names = [...`${first}${second}`.matchAll(/<strong>(Sender \d+)<\/strong>/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(total);
    expect(names).toHaveLength(total);
  });

  it("counts and pages through a long email list", async () => {
    const ctx = makeCtx();
    await addRows(ctx, "inbox", Array.from({ length: 150 }, (_, i) => inboxRow({ kind: "signup", email: `fan${i}@example.com`, received_at: new Date(Date.now() - i * 1000).toISOString() })));
    const list = await ownerPage(ctx, "/admin?tab=list");
    expect(list).toContain("150 people on your list");
    expect(list).toMatch(/href="\/admin\?tab=list&amp;cursor=/);
  });

  it("deletes one item, or clears new and archived items in batches", async () => {
    const ctx = makeCtx();
    await addRows(ctx, "inbox", Array.from({ length: 20 }, (_, i) => inboxRow({ email: `spam${i}@example.com`, message: "junk" })));
    const one = ctx.state.inbox[0];
    await post(ctx, `${APP}/admin/inbox/${one.id}`, { status: "archived", tab: "messages" }, owner);
    const archived = await ownerPage(ctx, "/admin?tab=archived");
    expect(archived).toContain('value="delete"');
    expect(await ownerPage(ctx, "/admin")).not.toContain('value="delete"');
    expect((await post(ctx, `${APP}/admin/inbox/${one.id}`, { status: "delete", tab: "archived" }, owner)).status).toBe(303);
    expect(ctx.state.inbox).toHaveLength(19);

    // Nothing happens without ticking the box.
    const unconfirmed = await post(ctx, `${APP}/admin/inbox`, { action: "archive-new" }, owner);
    expect(unconfirmed.headers.get("location")).toContain("done=confirm");
    expect(ctx.state.inbox.every((row) => row.status === "new")).toBe(true);

    const firstBatch = await post(ctx, `${APP}/admin/inbox`, { action: "archive-new", confirm: "yes" }, owner);
    expect(firstBatch.headers.get("location")).toContain("more=1");
    const flash = await ownerPage(ctx, firstBatch.headers.get("location")!);
    expect(flash).toContain("Archived 15 messages. More are waiting");
    await post(ctx, `${APP}/admin/inbox`, { action: "archive-new", confirm: "yes" }, owner);
    expect(ctx.state.inbox.every((row) => row.status === "archived")).toBe(true);

    await post(ctx, `${APP}/admin/inbox`, { action: "delete-archived", confirm: "yes" }, owner);
    await post(ctx, `${APP}/admin/inbox`, { action: "delete-archived", confirm: "yes" }, owner);
    expect(ctx.state.inbox).toHaveLength(0);
  });

  it("exports the email list as CSV with formula-safe cells", () => {
    const csv = toCsv([{ email: "ada@example.com", name: "=HYPERLINK(\"x\")", received_at: "2026-09-27T00:00:00.000Z" }]);
    expect(csv).toContain('"email","name","joined"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("downloads every address, and lists saved twice by older versions once", async () => {
    const ctx = makeCtx();
    await addRows(ctx, "inbox", Array.from({ length: 250 }, (_, i) => inboxRow({ kind: "signup", email: `fan${i}@example.com` })));
    await addRows(ctx, "inbox", [inboxRow({ kind: "signup", email: "FAN0@example.com" })]);
    const res = await get(ctx, `${APP}/admin/email-list.csv`, owner);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines).toHaveLength(251);
  });

  it("offers a very long list in parts instead of cutting it short", async () => {
    const ctx = makeCtx();
    const size = EXPORT_PAGES * 100;
    await addRows(ctx, "inbox", Array.from({ length: size + 40 }, (_, i) => inboxRow({ kind: "signup", email: `fan${i}@example.com`, received_at: new Date(Date.now() - i * 1000).toISOString() })));
    const res = await get(ctx, `${APP}/admin/email-list.csv`, owner);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Download in parts");
    const links = [...html.matchAll(/href="(\/admin\/email-list\.csv\?[^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
    const partOne = await (await get(ctx, `${APP}${links[0]}`, owner)).text();
    const partTwo = await (await get(ctx, `${APP}${links[1]}`, owner)).text();
    const emails = [...`${partOne}${partTwo}`.matchAll(/"(fan\d+@example\.com)"/g)].map((m) => m[1]);
    expect(emails).toHaveLength(size + 40);
    expect(new Set(emails).size).toBe(size + 40);
  });
});

describe("removing demo mode", () => {
  // Follows the steps in README.md: delete server/demo.js and every line in
  // server/index.js that ends in `// demo`, then runs the page and the owner
  // view on the shared runtime harness with the example's manifest.
  async function strippedApp(): Promise<Server> {
    const source = path.resolve(import.meta.dirname, "../server");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "link-in-bio-no-demo-"));
    for (const name of fs.readdirSync(source)) {
      if (name === "demo.js") continue;
      const code = fs.readFileSync(path.join(source, name), "utf8");
      const kept = code.split("\n").filter((line) => !/\/\/ demo$/u.test(line.trimEnd()));
      fs.writeFileSync(path.join(target, name), kept.join("\n"));
    }
    expect(fs.readFileSync(path.join(target, "index.js"), "utf8")).not.toContain("demoMode");
    return (await import(pathToFileURL(path.join(target, "index.js")).href)).default;
  }

  it("keeps the page, the forms, and the owner view working, even at the demo address", async () => {
    const server = await strippedApp();
    const ctx = makeCtx();

    const home = await get(ctx, `${DEMO}/`, {}, server);
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain("noindex");
    const signedOut = await get(ctx, `${DEMO}/admin`, {}, server);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/_userland/auth/login");

    expect((await post(ctx, `${APP}/admin/links/starter`, {}, owner, server)).status).toBe(303);
    expect((await post(ctx, `${APP}/admin/links`, { title: "New mug", url: "https://shop.example.com/mug", picture: "mug", visible: "yes" }, owner, server)).status).toBe(303);
    const mug = ctx.state.links.find((row) => row.title === "New mug")!;
    expect((await post(ctx, `${APP}/admin/links/${mug.id}`, { action: "hide" }, owner, server)).status).toBe(303);
    expect((await get(ctx, `${APP}/go/${ctx.state.links[0].id}`, {}, server)).status).toBe(302);

    expect((await post(ctx, `${APP}/subscribe`, { email: "fan@example.com" }, {}, server)).status).toBe(303);
    expect((await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "Hi" }, {}, server)).status).toBe(303);
    const [message] = ctx.state.inbox.filter((row) => row.kind === "message");
    expect(message.demo_key).toBe("");

    expect((await post(ctx, `${APP}/admin/inbox/${message.id}`, { status: "replied" }, owner, server)).status).toBe(303);
    expect(ctx.state.inbox.find((row) => row.id === message.id)!.status).toBe("replied");
    expect(await (await get(ctx, `${APP}/admin?tab=replied`, owner, server)).text()).toContain("ada@example.com");
    expect(await (await get(ctx, `${APP}/admin/links`, owner, server)).text()).toContain("1 tap");
    expect(await (await get(ctx, `${APP}/admin/email-list.csv`, owner, server)).text()).toContain("fan@example.com");
    expect(ctx.state.inbox.filter((row) => row.kind === "signup").map((row) => row.demo_key)).toEqual([""]);
  });
});

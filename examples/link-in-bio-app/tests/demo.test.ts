// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you remove demo mode (see README.md).
// They run on the same manifest-checked runtime as the other tests, so the
// demo's own queries (keys, visitor rows, cleanup) are checked against the
// declared fields and indexes too.
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { DEMO_HOSTS } from "../server/demo.js";
import { APP, Ctx, DEMO, get, hourStamp, keyFrom, makeCtx, post } from "./helpers.js";

async function newVisitor(ctx: Ctx) {
  const res = await get(ctx, `${DEMO}/admin`);
  expect(res.status).toBe(303);
  return keyFrom(res)!;
}

describe("public demo", () => {
  it("opens the owner view without sign-in and marks every page noindex", async () => {
    const ctx = makeCtx();
    const key = await newVisitor(ctx);
    const inbox = await get(ctx, `${DEMO}/admin?visit=${key}`);
    expect(inbox.status).toBe(200);
    const html = await inbox.text();
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain("https://userland.fun/examples/link-in-bio-app/");
    expect(html).toContain("Priya Raman"); // sample message
    for (const path of ["/", "/contact", "/thanks?kind=signup", `/admin/links?visit=${key}`]) {
      const page = await (await get(ctx, `${DEMO}${path}`)).text();
      expect(page).toContain('<meta name="robots" content="noindex,follow">');
      expect(page).toContain("See how it's made");
      // Crawlers are asked not to follow the ribbon into the owner view.
      expect(page).toMatch(/class="demo-owner-link" href="[^"]+" rel="nofollow"/);
    }
  });

  it("never shows one visitor's submissions or changes to another", async () => {
    const ctx = makeCtx();
    // Visitor A signs up from the public page with no key yet.
    const signup = await post(ctx, `${DEMO}/subscribe`, { email: "visitor-a@example.com" });
    expect(signup.status).toBe(303);
    const keyA = keyFrom(signup)!;
    await post(ctx, `${DEMO}/contact`, { visit: keyA, name: "Visitor A", email: "visitor-a@example.com", topic: "Collab", message: "Private note from A" });

    const keyB = await newVisitor(ctx);
    expect(keyB).not.toBe(keyA);

    const aList = await (await get(ctx, `${DEMO}/admin?tab=list&visit=${keyA}`)).text();
    const aInbox = await (await get(ctx, `${DEMO}/admin?visit=${keyA}`)).text();
    expect(aList).toContain("visitor-a@example.com");
    expect(aInbox).toContain("Private note from A");

    const bList = await (await get(ctx, `${DEMO}/admin?tab=list&visit=${keyB}`)).text();
    const bInbox = await (await get(ctx, `${DEMO}/admin?visit=${keyB}`)).text();
    const noKey = await (await get(ctx, `${DEMO}/admin?tab=list`)).text();
    for (const html of [bList, bInbox, noKey]) {
      expect(html).not.toContain("visitor-a@example.com");
      expect(html).not.toContain("Private note from A");
    }

    // A archives a sample message; B still sees it as new.
    const aPriya = ctx.state.inbox.find((r) => r.demo_key === keyA && r.name === "Priya Raman")!;
    await post(ctx, `${DEMO}/admin/inbox/${aPriya.id}`, { visit: keyA, status: "archived" });
    const bPriya = ctx.state.inbox.find((r) => r.demo_key === keyB && r.name === "Priya Raman")!;
    expect(bPriya.status).toBe("new");

    // B can't change A's rows by guessing ids.
    const cross = await post(ctx, `${DEMO}/admin/inbox/${aPriya.id}`, { visit: keyB, status: "new" });
    expect(cross.status).toBe(404);
    expect(ctx.state.inbox.find((r) => r.id === aPriya.id)!.status).toBe("archived");

    // A hides a link on their copy of the page; B's page and the shared page keep it.
    const aLink = ctx.state.links.find((r) => r.demo_key === keyA && r.title === "Speckled Pie Dish")!;
    await post(ctx, `${DEMO}/admin/links/${aLink.id}`, { visit: keyA, action: "hide" });
    expect(await (await get(ctx, `${DEMO}/?visit=${keyA}`)).text()).not.toContain("Speckled Pie Dish");
    expect(await (await get(ctx, `${DEMO}/?visit=${keyB}`)).text()).toContain("Speckled Pie Dish");
    expect(await (await get(ctx, `${DEMO}/`)).text()).toContain("Speckled Pie Dish");
  });

  it("shows where a link would go instead of leaving the demo, and counts the tap", async () => {
    const ctx = makeCtx();
    const key = await newVisitor(ctx);
    const link = ctx.state.links.find((r) => r.demo_key === key && r.title === "Speckled Pie Dish")!;
    const res = await get(ctx, `${DEMO}/go/${link.id}?visit=${key}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("This button would open");
    // The sample count is 212; the tap makes it 213.
    expect(await (await get(ctx, `${DEMO}/admin/links?visit=${key}`)).text()).toContain("213 taps");
  });

  it("only opens copies the demo handed out, and not expired ones", async () => {
    const ctx = makeCtx();
    const madeUp = `${hourStamp(-1)}-0001-bbbbbbbbbbbbbbbbbbbbbbbb`;
    await ctx.data.collection("inbox").create({ kind: "message", name: "Planted", email: "p@example.com", topic: "Collab", message: "Planted text", status: "new", received_at: new Date().toISOString(), demo_key: madeUp });
    for (const refused of ["2020010100-0001-aaaaaaaaaaaaaaaaaaaaaaaa", "20200101-aaaaaaaaaaaaaaaaaaaaaaaa", `${hourStamp(-7)}-0001-aaaaaaaaaaaaaaaaaaaaaaaa`, `${hourStamp(-1)}-aaaaaaaaaaaaaaaaaaaaaaaa`, madeUp]) {
      const res = await get(ctx, `${DEMO}/admin?visit=${refused}`);
      expect(res.status).toBe(303);
      expect(keyFrom(res)).not.toBe(refused);
      // The public page and forms ignore it too.
      expect(await (await get(ctx, `${DEMO}/contact?visit=${refused}`)).text()).not.toContain(refused);
    }
    // A key the demo handed out works.
    const key = await newVisitor(ctx);
    const ok = await get(ctx, `${DEMO}/admin?visit=${key}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain("Planted text");
  });

  it("opens a fresh copy when a link to someone's copy comes from another site", async () => {
    const ctx = makeCtx();
    const key = await newVisitor(ctx);
    const link = ctx.state.links.find((r) => r.demo_key === key && r.title === "Speckled Pie Dish")!;
    await post(ctx, `${DEMO}/admin/links/${link.id}`, { visit: key, action: "save", title: "Planted title", url: "https://example.com/planted", picture: "mug", visible: "yes", featured: "yes" });
    expect(await (await get(ctx, `${DEMO}/?visit=${key}`)).text()).toContain("Planted title");

    for (const site of ["cross-site", "same-site"]) {
      const page = await (await get(ctx, `${DEMO}/?visit=${key}`, { "sec-fetch-site": site })).text();
      expect(page).not.toContain("Planted title");
      const admin = await get(ctx, `${DEMO}/admin?visit=${key}`, { "sec-fetch-site": site });
      expect(admin.status).toBe(303);
      expect(keyFrom(admin)).not.toBe(key);
    }
    // A form on another site can't post into the copy either.
    await post(ctx, `${DEMO}/contact`, { visit: key, name: "Evil", email: "e@example.com", topic: "Collab", message: "From elsewhere" }, { origin: "https://evil.example" });
    expect(ctx.state.inbox.some((r) => r.demo_key === key && r.message === "From elsewhere")).toBe(false);
    // Typed in, or from the demo's own pages, it still opens.
    expect(await (await get(ctx, `${DEMO}/?visit=${key}`, { "sec-fetch-site": "none" })).text()).toContain("Planted title");
  });

  it("warns on the public forms that a copy's address opens it", async () => {
    const ctx = makeCtx();
    const key = await newVisitor(ctx);
    for (const path of [`/?visit=${key}`, `/contact?visit=${key}`]) {
      expect(await (await get(ctx, `${DEMO}${path}`)).text()).toContain("anyone with this page's exact address can open");
    }
  });

  it("says the demo is busy instead of handing out endless copies", async () => {
    const ctx = makeCtx();
    const hour = hourStamp(0);
    // Pretend 50 visitors already arrived this hour.
    for (let n = 1; n <= 50; n += 1) {
      const number = String(n).padStart(4, "0");
      await ctx.data.collection("inbox").create({ demo_key: `${hour}-${number}-${"c".repeat(24)}`, slot: `visitors/${hour}/${number}`, received_at: new Date().toISOString() });
    }
    const before = ctx.state.total;
    const res = await get(ctx, `${DEMO}/admin`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("The demo is busy right now");
    const signup = await post(ctx, `${DEMO}/subscribe`, { email: "late@example.com" });
    expect(signup.status).toBe(503);
    expect(ctx.state.total).toBe(before);
  });

  it("doesn't use up the hour's copies on scripts and link checkers", async () => {
    const ctx = makeCtx();
    for (const agent of ["curl/8.4.0", "python-requests/2.31", "Mozilla/5.0 (compatible; Googlebot/2.1)"]) {
      const res = await get(ctx, `${DEMO}/admin`, { "user-agent": agent });
      expect(res.status).toBe(303);
      expect((await post(ctx, `${DEMO}/contact`, { name: "Bot", email: "bot@example.com", topic: "Collab", message: "Hi there" }, { "user-agent": agent })).status).toBe(303);
      expect((await post(ctx, `${DEMO}/subscribe`, { email: "bot@example.com" }, { "user-agent": agent })).status).toBe(303);
    }
    expect(ctx.state.total).toBe(0);
    // A person's browser still gets a copy.
    expect(await newVisitor(ctx)).toBeTruthy();
    expect(ctx.state.visitors).toHaveLength(1);
  });

  it("gives many visitors who arrive together their own copies instead of saying it's busy", async () => {
    const ctx = makeCtx();
    const responses = await Promise.all(Array.from({ length: 20 }, () => get(ctx, `${DEMO}/admin`)));
    expect(responses.map((res) => res.status)).toEqual(Array(20).fill(303));
    expect(new Set(responses.map(keyFrom)).size).toBe(20);
    expect(new Set(ctx.state.visitors.map((row) => row.slot)).size).toBe(20);
    expect(ctx.state.visitors).toHaveLength(20);
  });

  it("marks a visitor's copy as a practice copy on every page", async () => {
    const ctx = makeCtx();
    const key = await newVisitor(ctx);
    for (const path of [`/?visit=${key}`, `/contact?visit=${key}`, `/admin?visit=${key}`]) {
      expect(await (await get(ctx, `${DEMO}${path}`)).text()).toContain("This is a visitor's practice copy.");
    }
    expect(await (await get(ctx, `${DEMO}/`)).text()).not.toContain("practice copy.");
  });

  it("gives visitors who arrive together their own copies", async () => {
    const ctx = makeCtx();
    const keys = await Promise.all(Array.from({ length: 5 }, () => newVisitor(ctx)));
    expect(new Set(keys).size).toBe(5);
    expect(new Set(ctx.state.visitors.map((row) => row.slot)).size).toBe(5);
    for (const key of keys) {
      expect(ctx.state.links.filter((row) => row.demo_key === key)).toHaveLength(8);
      expect((await get(ctx, `${DEMO}/admin?visit=${key}`)).status).toBe(200);
    }
  });

  it("doesn't let one visitor pile up rows, starter links included", async () => {
    const ctx = makeCtx();
    const key = await newVisitor(ctx);
    for (let i = 0; i < 5; i += 1) {
      const res = await post(ctx, `${DEMO}/admin/links/starter`, { visit: key });
      expect([303, 429]).toContain(res.status);
    }
    expect(ctx.state.links.filter((row) => row.demo_key === key)).toHaveLength(8);
    let refused = 0;
    for (let i = 0; i < 70; i += 1) {
      const res = await post(ctx, `${DEMO}/admin/links`, { visit: key, title: `Link ${i}`, url: "https://example.com/x", visible: "yes" });
      if (res.status === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
    expect(ctx.state.links.filter((row) => row.demo_key === key).length).toBeLessThanOrEqual(60);
    // Once full, starter links are refused too.
    expect((await post(ctx, `${DEMO}/admin/links/starter`, { visit: key })).status).toBe(429);
  });

  it("clears out expired copies, tap counts and all", async () => {
    const ctx = makeCtx();
    const old = `${hourStamp(-7)}-0001-${"d".repeat(24)}`;
    const link = await ctx.data.collection("links").create({ title: "Old", url: "https://example.com", visible: true, position: 1, clicks: 0, demo_key: old });
    await ctx.data.collection("links").create({ demo_key: old, slot: `${old}/taps/${link.id}/1`, clicks: 1 });
    await ctx.data.collection("inbox").create({ kind: "message", name: "Old", email: "o@example.com", topic: "Collab", message: "Old", status: "new", received_at: new Date().toISOString(), demo_key: old });
    await ctx.data.collection("inbox").create({ demo_key: old, slot: `visitors/${hourStamp(-7)}/0001`, received_at: new Date().toISOString() });
    await newVisitor(ctx);
    expect(JSON.stringify(ctx.state)).not.toContain(old);
  });

  it("never stores a typed email address in full", async () => {
    const ctx = makeCtx();
    const signup = await post(ctx, `${DEMO}/subscribe`, { email: "alice.smith@realmail.com" });
    const key = keyFrom(signup)!;
    await post(ctx, `${DEMO}/contact`, { visit: key, name: "Al", email: "al@work.co.uk", topic: "Collab", message: "Hello there" });
    const stored = ctx.state.inbox.filter((r) => r.demo_key === key).map((r) => r.email);
    expect(stored).toContain("a•••@r•••.com");
    expect(stored).toContain("a•••@w•••.uk");
    expect(JSON.stringify(ctx.state)).not.toContain("realmail");
    const inbox = await (await get(ctx, `${DEMO}/admin?visit=${key}`)).text();
    expect(inbox).toContain('share <a href="https://link-in-bio-demo.apps.userland.fun/">');
    // Hidden addresses show as plain text, not as email links.
    expect(inbox).not.toContain("mailto:a•");
    expect(inbox).toContain("a•••@w•••.uk");
    // Two different real addresses that hide the same way stay two signups.
    await post(ctx, `${DEMO}/subscribe`, { visit: key, email: "anne@rainmail.com" });
    expect(ctx.state.inbox.filter((r) => r.demo_key === key && r.email === "a•••@r•••.com" && r.kind === "signup")).toHaveLength(2);
    const list = await (await get(ctx, `${DEMO}/admin?tab=list&visit=${key}`)).text();
    expect(list).toContain("Download list (spreadsheet)");
    expect(list).toContain("a•••@r•••.com");
    expect(list).not.toContain("mailto:a•");
    // A sample address signed up again stays one signup.
    await post(ctx, `${DEMO}/subscribe`, { visit: key, email: "maya.k@example.com" });
    expect(ctx.state.inbox.filter((r) => r.demo_key === key && r.email === "maya.k@example.com")).toHaveLength(1);
  });

  it("runs at the demo's addresses on both apps.userland.fun and userland.link, and shares the address on the same domain", async () => {
    const hosts = ["link-in-bio-demo.apps.userland.fun", "7hc3cpnov6tzt3v6rdd.apps.userland.fun", "link-in-bio-demo.userland.link", "7hc3cpnov6tzt3v6rdd.userland.link"];
    expect([...DEMO_HOSTS].sort()).toEqual([...hosts].sort());
    for (const host of hosts) {
      const ctx = makeCtx();
      const start = await get(ctx, `https://${host}/admin`);
      expect(start.status, host).toBe(303);
      const key = keyFrom(start);
      expect(key, host).not.toBeNull();
      const inbox = await (await get(ctx, `https://${host}/admin?visit=${key}`)).text();
      expect(inbox, host).toContain('<meta name="robots" content="noindex,follow">');
      const shared = host.endsWith(".userland.link") ? "link-in-bio-demo.userland.link" : "link-in-bio-demo.apps.userland.fun";
      expect(inbox, host).toContain(`share <a href="https://${shared}/">${shared}</a>`);
    }
    for (const host of ["example-check.userland.link", "example-check.apps.userland.fun"]) {
      const ctx = makeCtx();
      const page = await get(ctx, `https://${host}/admin`);
      expect(keyFrom(page), host).toBeNull();
      expect(await (await get(ctx, `https://${host}/`)).text(), host).not.toContain("noindex");
    }
  });

  it("tells demo visitors that made-up details are fine", async () => {
    const ctx = makeCtx();
    expect(await (await get(ctx, `${DEMO}/`)).text()).toContain("Made-up details work fine");
    expect(await (await get(ctx, `${DEMO}/contact`)).text()).toContain("Made-up details work fine");
    expect(await (await get(ctx, `${APP}/`)).text()).not.toContain("Made-up details");
  });

  it("adds the shared starter links once, even for simultaneous first visits", async () => {
    const ctx = makeCtx();
    await Promise.all([get(ctx, `${DEMO}/`), get(ctx, `${DEMO}/`), get(ctx, `${DEMO}/`)]);
    await get(ctx, `${DEMO}/`);
    const titles = ctx.state.links.filter((r) => r.demo_key === "").map((r) => r.title);
    expect(titles).toHaveLength(8);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("treats broken addresses as not found instead of an error", async () => {
    const ctx = makeCtx();
    expect((await get(ctx, `${DEMO}/go/%E0%A4%A`)).status).toBe(404);
    const key = await newVisitor(ctx);
    expect((await get(ctx, `${DEMO}/admin/links/%E0%A4%A?visit=${key}`)).status).toBe(404);
    expect((await post(ctx, `${DEMO}/admin/inbox/%E0%A4%A`, { visit: key, status: "new" })).status).toBe(404);
    expect(ctx.log.error).not.toHaveBeenCalled();
  });
});

describe("HEAD requests to the demo", () => {
  it("answer the demo's owner view and link pages like GET", async () => {
    const ctx = makeCtx();
    const start = await get(ctx, `${DEMO}/admin`);
    expect(start.status).toBe(303);
    const key = /visit=([^&]+)/.exec(start.headers.get("location")!)![1];
    const link = ctx.state.links.find((row) => row.demo_key === key)!;
    const pages: Array<[string, number]> = [
      [`${DEMO}/admin?visit=${key}`, 200],
      [`${DEMO}/admin?tab=list&visit=${key}`, 200],
      [`${DEMO}/admin/links?visit=${key}`, 200],
      [`${DEMO}/go/${link.id}?visit=${key}`, 200],
      [`${DEMO}/go/social/instagram`, 200],
      [`${DEMO}/go/social/nope`, 404]
    ];
    for (const [url, status] of pages) {
      expect((await expectHeadLikeGet(app, ctx, url)).status).toBe(status);
    }
  });

  it("don't set up a demo copy for a visitor with no key", async () => {
    const ctx = makeCtx();
    await get(ctx, `${DEMO}/`); // the shared starter links
    const before = JSON.stringify(ctx.state);
    const res = await app.fetch(new Request(`${DEMO}/admin`, { method: "HEAD" }), ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/admin\?visit=\d{10}-0000-[a-f0-9]{24}$/);
    expect(await res.text()).toBe("");
    expect(JSON.stringify(ctx.state)).toBe(before);
  });
});

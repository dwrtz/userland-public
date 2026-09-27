// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you remove demo mode (see README.md).
import { APP, Ctx, DEMO, FAN_COOKIE, OWNER_COOKIE, Row, addStarterLinks, get, hourStamp, makeCtx, post } from "./helpers.js";

describe("public demo", () => {
  async function newVisitor(ctx: Ctx) {
    const res = await get(ctx, `${DEMO}/admin`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    const key = /visit=([^&]+)/.exec(location)![1];
    return key;
  }

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
    }
  });

  it("never shows one visitor's submissions or changes to another", async () => {
    const ctx = makeCtx();
    // Visitor A signs up from the public page with no key yet.
    const signup = await post(ctx, `${DEMO}/subscribe`, { email: "visitor-a@example.com" });
    expect(signup.status).toBe(303);
    const keyA = /visit=([^&]+)/.exec(signup.headers.get("location")!)![1];
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

  it("shows where a link would go instead of leaving the demo", async () => {
    const ctx = makeCtx();
    await get(ctx, `${DEMO}/`); // adds the shared starter links
    const link = ctx.state.links.find((r) => r.demo_key === "")!;
    const res = await get(ctx, `${DEMO}/go/${link.id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("This button would open");
  });

  it("ignores made-up or expired visitor keys", async () => {
    const ctx = makeCtx();
    for (const stale of ["2020010100-aaaaaaaaaaaaaaaaaaaaaaaa", "20200101-aaaaaaaaaaaaaaaaaaaaaaaa", `${hourStamp(-7)}-aaaaaaaaaaaaaaaaaaaaaaaa`]) {
      const res = await get(ctx, `${DEMO}/admin?visit=${stale}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).not.toContain(stale);
    }
    // A key from earlier today still works.
    const recent = `${hourStamp(-1)}-bbbbbbbbbbbbbbbbbbbbbbbb`;
    ctx.state.inbox.push({ id: "recent-1", kind: "message", name: "Recent", email: "r@example.com", topic: "Collab", message: "Still here", status: "new", received_at: new Date().toISOString(), demo_key: recent });
    const ok = await get(ctx, `${DEMO}/admin?visit=${recent}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Still here");
  });

  it("never stores a typed email address in full", async () => {
    const ctx = makeCtx();
    const signup = await post(ctx, `${DEMO}/subscribe`, { email: "alice.smith@realmail.com" });
    const key = /visit=([^&]+)/.exec(signup.headers.get("location")!)![1];
    await post(ctx, `${DEMO}/contact`, { visit: key, name: "Al", email: "al@work.co.uk", topic: "Collab", message: "Hello there" });
    const stored = ctx.state.inbox.filter((r) => r.demo_key === key).map((r) => r.email);
    expect(stored).toContain("a\u2022\u2022\u2022@r\u2022\u2022\u2022.com");
    expect(stored).toContain("a\u2022\u2022\u2022@w\u2022\u2022\u2022.uk");
    expect(JSON.stringify(ctx.state.inbox)).not.toContain("realmail");
    const inbox = await (await get(ctx, `${DEMO}/admin?visit=${key}`)).text();
    expect(inbox).toContain("share <a href=\"https://link-in-bio-demo.apps.userland.fun/\">");
    // Hidden addresses show as plain text, not as email links.
    expect(inbox).not.toContain("mailto:a\u2022");
    expect(inbox).toContain("a\u2022\u2022\u2022@w\u2022\u2022\u2022.uk");
    // Two different real addresses that hide the same way stay two signups.
    await post(ctx, `${DEMO}/subscribe`, { visit: key, email: "anne@rainmail.com" });
    expect(ctx.state.inbox.filter((r) => r.demo_key === key && r.email === "a\u2022\u2022\u2022@r\u2022\u2022\u2022.com" && r.kind === "signup")).toHaveLength(2);
    const list = await (await get(ctx, `${DEMO}/admin?tab=list&visit=${key}`)).text();
    expect(list).toContain("Download list (spreadsheet)");
    expect(list).toContain("a\u2022\u2022\u2022@r\u2022\u2022\u2022.com");
    expect(list).not.toContain("mailto:a\u2022");
  });

  it("tells demo visitors that made-up details are fine", async () => {
    const ctx = makeCtx();
    expect(await (await get(ctx, `${DEMO}/`)).text()).toContain("Made-up details work fine");
    expect(await (await get(ctx, `${DEMO}/contact`)).text()).toContain("Made-up details work fine");
    expect(await (await get(ctx, `${APP}/`)).text()).not.toContain("Made-up details");
  });

  it("cleans up duplicate starter links from simultaneous first visits", async () => {
    const ctx = makeCtx();
    await Promise.all([get(ctx, `${DEMO}/`), get(ctx, `${DEMO}/`), get(ctx, `${DEMO}/`)]);
    await get(ctx, `${DEMO}/`);
    const titles = ctx.state.links.filter((r) => r.demo_key === "").map((r) => r.title);
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

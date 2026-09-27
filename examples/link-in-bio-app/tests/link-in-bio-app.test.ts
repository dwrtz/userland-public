import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { toCsv } from "../server/index.js";
import { APP, Ctx, DEMO, FAN_COOKIE, OWNER_COOKIE, Row, addStarterLinks, get, hourStamp, makeCtx, post, type Server } from "./helpers.js";

describe("public page", () => {
  it("shows the profile, featured products, and visible links in order", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const hidden = ctx.state.links.find((l) => l.title === "Wholesale and cafe orders")!;
    hidden.visible = false;

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
    expect(ctx.state.links[0].clicks).toBe(1);
  });
});

describe("email list and contact form", () => {
  it("adds a signup once per address", async () => {
    const ctx = makeCtx();
    const first = await post(ctx, `${APP}/subscribe`, { name: "Ada", email: "ada@example.com" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/thanks?kind=signup");
    await post(ctx, `${APP}/subscribe`, { email: "ADA@example.com" });
    expect(ctx.state.inbox).toHaveLength(1);
    expect(ctx.state.inbox[0]).toMatchObject({ kind: "signup", email: "ada@example.com", status: "new", demo_key: "" });
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

  it("rejects addresses that would add fields to the owner's reply email", async () => {
    const ctx = makeCtx();
    for (const email of ["x@y.com?bcc=evil%40ex.com", "x@y.com&cc=a@b.com", "x@y.com#frag", "x%40y@z.com"]) {
      const res = await post(ctx, `${APP}/contact`, { name: "Ada", email, topic: "Wholesale", message: "Hi" });
      expect(res.status).toBe(422);
    }
    expect(ctx.state.inbox).toHaveLength(0);

    await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada.o'neil+shop@mail.example.co.uk", topic: "Wholesale", message: "Hi" });
    const inbox = await (await get(ctx, `${APP}/admin`, { cookie: OWNER_COOKIE })).text();
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

    const inbox = await (await get(ctx, `${APP}/admin`, { cookie: OWNER_COOKIE })).text();
    expect(inbox).toContain("Hello &lt;b&gt;Wren&lt;/b&gt;");
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

  it("refuses cross-site posts even with an owner session", async () => {
    const ctx = makeCtx();
    const res = await post(ctx, `${APP}/admin/links/starter`, {}, { cookie: OWNER_COOKIE, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(ctx.state.links).toHaveLength(0);
  });

  it("lets the owner manage links and the inbox", async () => {
    const ctx = makeCtx();
    const owner = { cookie: OWNER_COOKIE, origin: APP };
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

    await post(ctx, `${APP}/admin/links/${id}`, { action: "delete" }, owner);
    expect(ctx.state.links).toHaveLength(0);
  });

  it("moves links up and down", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const second = ctx.state.links.find((l) => l.position === 2)!;
    await post(ctx, `${APP}/admin/links/${second.id}`, { action: "up" }, { cookie: OWNER_COOKIE });
    const html = await (await get(ctx, `${APP}/`)).text();
    expect(html.indexOf("Morning Mugs")).toBeLessThan(html.indexOf("Speckled Pie Dish"));
  });

  it("exports the email list as CSV with formula-safe cells", () => {
    const csv = toCsv([{ email: "ada@example.com", name: "=HYPERLINK(\"x\")", received_at: "2026-09-27T00:00:00.000Z" }]);
    expect(csv).toContain('"email","name","joined"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
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
    const rt = createFakeRuntime(readExampleManifest(path.resolve(import.meta.dirname, "..")));
    const ctx = rt.ctx as any;
    const owner = { origin: APP };

    const home = await get(ctx, `${DEMO}/`, {}, server);
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain("noindex");
    const signedOut = await get(ctx, `${DEMO}/admin`, {}, server);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/_userland/auth/login");

    rt.setUser({ id: "u_owner", app_user_id: "u_owner", email: "wren@example.com", roles: ["owner"] });
    expect((await post(ctx, `${APP}/admin/links/starter`, {}, owner, server)).status).toBe(303);
    expect((await post(ctx, `${APP}/admin/links`, { title: "New mug", url: "https://shop.example.com/mug", picture: "mug", visible: "yes" }, owner, server)).status).toBe(303);
    const mug = rt.state.rows.get("links")!.find((row) => row.data.title === "New mug")!;
    expect((await post(ctx, `${APP}/admin/links/${mug.id}`, { action: "hide" }, owner, server)).status).toBe(303);
    rt.setUser(null);

    expect((await post(ctx, `${APP}/subscribe`, { email: "fan@example.com" }, { origin: APP }, server)).status).toBe(303);
    expect((await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "Hi" }, { origin: APP }, server)).status).toBe(303);
    const [message] = rt.state.rows.get("inbox")!.filter((row) => row.data.kind === "message");
    expect(message!.data.demo_key).toBe("");

    rt.setUser({ id: "u_owner", app_user_id: "u_owner", email: "wren@example.com", roles: ["owner"] });
    expect((await post(ctx, `${APP}/admin/inbox/${message!.id}`, { status: "replied" }, owner, server)).status).toBe(303);
    expect(rt.state.rows.get("inbox")!.find((row) => row.id === message!.id)!.data.status).toBe("replied");
    expect(await (await get(ctx, `${APP}/admin`, {}, server)).text()).toContain("ada@example.com");
    expect(rt.state.rows.get("inbox")!.filter((row) => row.data.kind === "signup").map((row) => row.data.demo_key)).toEqual([""]);
  });
});

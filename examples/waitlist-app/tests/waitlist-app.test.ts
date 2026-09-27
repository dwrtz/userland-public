import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { rankWaitlist, toCsv, REFERRAL_BOOST } from "../server/waitlist.js";
import { APP, DEMO, call, collections, join, makeCtx, owner, post, type Server } from "./helpers.js";

describe("public visitor", () => {
  it("joins, sees a place in line, and saves optional answers", async () => {
    const ctx = makeCtx();
    const landing = await call(ctx, `${APP}/`);
    expect(landing.status).toBe(200);
    const landingHtml = await landing.text();
    expect(landingHtml).toContain('action="/join"');
    expect(landingHtml).not.toContain('name="robots" content="noindex');

    const statusPath = await join(ctx, APP, { email: "Ada@Example.com ", name: "Ada" });
    const status = await call(ctx, `${APP}${statusPath}`);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const statusHtml = await status.text();
    expect(statusHtml).toContain("You're in, Ada.");
    expect(statusHtml).toContain("#</span>1</p>");
    expect(statusHtml).toContain('<meta name="robots" content="noindex">');
    expect(ctx.log.info).toHaveBeenCalledWith("waitlist signup", expect.objectContaining({ referred: false }));
    expect(ctx.tables.signups[0]).toMatchObject({ email: "ada@example.com", status: "waiting" });

    const saved = await post(ctx, `${APP}${statusPath}/answers`, { frequency: "weekly", goal: "company", city: "Portland" });
    expect(saved.headers.get("location")).toBe(`${statusPath}?saved=1`);
    expect(ctx.tables.signups[0]).toMatchObject({ frequency: "weekly", goal: "company", city: "Portland" });
  });

  it("rejects bad input, duplicates, bots, and wrong private links", async () => {
    const ctx = makeCtx();
    const invalid = await post(ctx, `${APP}/join`, { email: "not-an-email" });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("doesn&#39;t look right");
    for (const email of ['a"><script>alert(1)</script>@evil.io', "(x)@example.com", "x@localhost", "a b@example.com"]) {
      expect((await post(ctx, `${APP}/join`, { email })).status).toBe(400);
    }
    expect(ctx.tables.signups ?? []).toHaveLength(0);

    await join(ctx, APP, { email: "ada@example.com" });
    // A repeat email gets the same neutral answer as a bot, so the form can't
    // be used to check whether someone signed up.
    const duplicate = await post(ctx, `${APP}/join`, { email: "ADA@example.com" });
    expect(duplicate.status).toBe(303);
    expect(duplicate.headers.get("location")).toBe("/thanks");

    const bot = await post(ctx, `${APP}/join`, { email: "bot@example.com", company: "Spam Inc" });
    expect(bot.status).toBe(303);
    expect(bot.headers.get("location")).toBe("/thanks");
    expect(ctx.tables.signups).toHaveLength(1);
    expect(await (await call(ctx, `${APP}/thanks`)).text()).toContain("If you joined before");

    const crossSite = await post(ctx, `${APP}/join`, { email: "x@example.com" }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(400);

    const id = ctx.tables.signups[0].id;
    expect((await call(ctx, `${APP}/you/${id}/wrong-token`)).status).toBe(404);
  });

  it("moves the referrer up the line when a friend joins with their link", async () => {
    const ctx = makeCtx();
    // Give each signup its own join time, one minute apart.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-01T12:00:00Z") });
    const firstPaths = [];
    for (let index = 0; index < 12; index += 1) {
      firstPaths.push(await join(ctx, APP, { email: `runner${index}@example.com` }));
      vi.setSystemTime(Date.now() + 60_000);
    }
    const last = ctx.tables.signups[11];

    const shortLink = await call(ctx, `${APP}/r/${String(last.referral_code).toLowerCase()}`);
    expect(shortLink.headers.get("location")).toBe(`/?ref=${last.referral_code}`);
    expect(await (await call(ctx, `${APP}/?ref=${last.referral_code}`)).text()).toContain("saved you a spot");

    await join(ctx, APP, { email: "friend@example.com", ref: String(last.referral_code) });
    expect(ctx.tables.signups[12]).toMatchObject({ referred_by: last.referral_code, source: "friend" });

    const html = await (await call(ctx, `${APP}${firstPaths[11]}`)).text();
    expect(html).toContain(`#</span>${12 - REFERRAL_BOOST}</p>`);
    expect(html).toContain("<b>1</b> friend has joined");
    vi.useRealTimers();
  });

  it("counts every friend who joins at the same moment, and drops credit for archived ones", async () => {
    const ctx = makeCtx();
    const hostPath = await join(ctx, APP, { email: "host@example.com" });
    const code = String(ctx.tables.signups[0].referral_code);
    // Nothing is read-then-written on the referrer, so simultaneous joins can't lose a credit.
    await Promise.all(["f1", "f2", "f3"].map((name) => join(ctx, APP, { email: `${name}@example.com`, ref: code })));
    expect(await (await call(ctx, `${APP}${hostPath}`)).text()).toContain("<b>3</b> friends have joined");

    const fake = ctx.tables.signups.find((row) => row.email === "f3@example.com");
    await post(ctx, `${APP}/admin/signups/${fake?.id}/status`, { status: "archived" }, owner);
    expect(await (await call(ctx, `${APP}${hostPath}`)).text()).toContain("<b>2</b> friends have joined");
  });

  it("reads one page of signups, not the whole list, for the public landing page", async () => {
    const ctx = makeCtx();
    const signups = ctx.data.collection("signups");
    for (let index = 0; index < 250; index += 1) {
      await signups.create({ email: `r${index}@example.com`, status: "waiting", joined_at: new Date().toISOString(), referral_code: `R${index}` });
    }
    const list = vi.fn(signups.list);
    const collection = ctx.data.collection;
    ctx.data.collection = ((name: string) => ({ ...collection(name), list })) as typeof collection;
    const html = await (await call(ctx, `${APP}/`)).text();
    expect(list).toHaveBeenCalledTimes(1);
    expect(html).toContain("<b>100+</b> runners have already joined.");
  });

  it("escapes what people type", async () => {
    const ctx = makeCtx();
    const statusPath = await join(ctx, APP, { email: "x@example.com", name: "<script>alert(1)</script>" });
    const html = await (await call(ctx, `${APP}${statusPath}`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    const ownerHtml = await (await call(ctx, `${APP}/admin`, { headers: owner })).text();
    expect(ownerHtml).not.toContain("<script>alert");
  });
});

describe("owner view with demo mode off", () => {
  it("sends signed-out visitors to sign in and blocks accounts without the owner role", async () => {
    const ctx = makeCtx();
    await join(ctx, APP, { email: "ada@example.com" });

    const signedOut = await call(ctx, `${APP}/admin?status=waiting`);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin%3Fstatus%3Dwaiting");
    expect((await call(ctx, `${APP}/admin/export.csv`)).status).toBe(303);

    const id = ctx.tables.signups[0].id;
    const blockedChange = await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "invited" });
    expect(blockedChange.status).toBe(303);
    expect(ctx.tables.signups[0].status).toBe("waiting");

    const helper = await call(ctx, `${APP}/admin`, { headers: { cookie: "__Host-ul_session=helper" } });
    expect(helper.status).toBe(403);
    expect(await helper.text()).not.toContain("ada@example.com");
  });

  it("lets the owner filter, change status, and export", async () => {
    const ctx = makeCtx();
    const adaPath = await join(ctx, APP, { email: "ada@example.com", name: "Ada" });
    await post(ctx, `${APP}${adaPath}/answers`, { frequency: "training", goal: "race" });
    await join(ctx, APP, { email: "=cmd@example.com", name: "@SUM(A1)" });

    const page = await call(ctx, `${APP}/admin`, { headers: owner });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("demo-bar");

    const filtered = await (await call(ctx, `${APP}/admin?frequency=training`, { headers: owner })).text();
    expect(filtered).toContain("ada@example.com");
    expect(filtered).not.toContain("=cmd@example.com");

    const id = ctx.tables.signups[0].id;
    const changed = await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "invited", back: "/admin?frequency=training" }, owner);
    expect(changed.headers.get("location")).toBe("/admin?frequency=training&done=invited");
    expect(ctx.tables.signups[0]).toMatchObject({ status: "invited" });
    expect(ctx.log.info).toHaveBeenCalledWith("waitlist status changed", { signup_id: id, status: "invited" });

    const offsite = await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "waiting", back: "//evil.example/admin" }, owner);
    expect(offsite.headers.get("location")).toBe("/admin?done=waiting");

    const csv = await call(ctx, `${APP}/admin/export.csv`, { headers: owner });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toContain("place_in_line,name,email");
    expect(text).toContain("'@SUM(A1)");
    expect(text).toContain("'=cmd@example.com");
  });
});

describe("waitlist rules", () => {
  it("orders by join time and moves people up for referrals", () => {
    const row = (id: string, minute: number, referrals = 0, status = "waiting") => ({
      id,
      joined_at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
      referrals,
      status
    });
    const rows = Array.from({ length: 15 }, (_, index) => row(`r${index}`, index));
    rows[14].referrals = 1;
    rows[0].status = "invited";
    const { positions, waitingCount } = rankWaitlist(rows);
    expect(waitingCount).toBe(14);
    expect(positions.get("r1")).toBe(1);
    expect(positions.get("r14")).toBe(4);
    expect(positions.has("r0")).toBe(false);
  });
});

describe("removing demo mode", () => {
  // Follows the steps in README.md on a copy of server/ and the manifest:
  // delete demo.js, every line ending in `// demo`, and the demo-signups collection.
  async function strippedApp(): Promise<Server> {
    const source = path.resolve(import.meta.dirname, "../server");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "waitlist-app-no-demo-"));
    for (const name of fs.readdirSync(source)) {
      if (name === "demo.js") continue;
      const code = fs.readFileSync(path.join(source, name), "utf8");
      const kept = code.split("\n").filter((line) => !/\/\/ demo$/u.test(line.trimEnd()));
      fs.writeFileSync(path.join(target, name), kept.join("\n"));
    }
    const stripped = fs.readFileSync(path.join(target, "index.js"), "utf8");
    expect(stripped).not.toContain("demoMode.");
    return (await import(pathToFileURL(path.join(target, "index.js")).href)).default;
  }

  it("keeps the waitlist, private pages, and owner view working, even at the demo address", async () => {
    const server = await strippedApp();
    const { "demo-signups": _removed, ...rest } = collections;
    const ctx = makeCtx(rest);

    const landing = await (await call(ctx, `${DEMO}/`, {}, server)).text();
    expect(landing).not.toContain("demo-bar");
    expect(landing).not.toContain("noindex");
    const adaPath = await join(ctx, DEMO, { email: "ada@example.com", name: "Ada" }, server);
    expect(ctx.tables.signups).toHaveLength(1);
    expect((await call(ctx, `${DEMO}${adaPath}`, {}, server)).status).toBe(200);
    expect((await post(ctx, `${DEMO}${adaPath}/answers`, { frequency: "weekly", goal: "race" }, {}, server)).status).toBe(303);

    const signedOut = await call(ctx, `${DEMO}/admin`, {}, server);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/_userland/auth/login");

    const page = await (await call(ctx, `${APP}/admin`, { headers: owner }, server)).text();
    expect(page).toContain("ada@example.com");
    const id = ctx.tables.signups[0].id;
    expect((await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "invited" }, owner, server)).status).toBe(303);
    expect(ctx.tables.signups[0]).toMatchObject({ status: "invited" });
    expect(await (await call(ctx, `${APP}/admin/export.csv`, { headers: owner }, server)).text()).toContain("ada@example.com");
  });
});

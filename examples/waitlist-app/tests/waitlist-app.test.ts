import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { BULK_LIMIT, REFERRAL_BOOST, emailKey, listAll, rankWaitlist, withReferralCounts } from "../server/waitlist.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { BRAND, statusPage } from "../server/views.js";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
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

    const bot = await post(ctx, `${APP}/join`, { email: "bot@example.com", leave_blank: "Spam Inc" });
    expect(bot.status).toBe(303);
    expect(bot.headers.get("location")).toBe("/thanks");
    expect(ctx.tables.signups).toHaveLength(1);
    // Caught bots leave a warning (no email) so the owner can spot false alarms.
    expect(ctx.log.warn).toHaveBeenCalledWith("waitlist signup ignored", { reason: "honeypot", demo: false });
    const thanks = await (await call(ctx, `${APP}/thanks`)).text();
    expect(thanks).toContain("If you joined before");
    // Someone who lost their private link knows who to ask for a new one.
    expect(thanks).toContain(BRAND.contactEmail);

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

  it("leaves no demo-only test behind once tests/demo.test.ts is deleted", () => {
    // The removal steps delete tests/demo.test.ts, then say to run the tests.
    // Any test elsewhere that needs demo mode would fail at that point, so
    // demo-only tests must live in tests/demo.test.ts. (Patterns are split so
    // this file doesn't match itself.)
    const demoOnly = ["?demo" + "=", "demo" + "=${", "server/demo" + ".js", 'tables["demo-' + 'signups"]', "sample" + "Signups"];
    const dir = path.resolve(import.meta.dirname);
    for (const name of fs.readdirSync(dir)) {
      if (name === "demo.test.ts") continue;
      const code = fs.readFileSync(path.join(dir, name), "utf8");
      for (const pattern of demoOnly) expect(code.includes(pattern), `${name} uses ${pattern}`).toBe(false);
    }
  });
});

describe("HEAD requests", () => {
  it("answer every page like GET, without a body", async () => {
    const ctx = makeCtx();
    const statusPath = await join(ctx, APP, { email: "ada@example.com", name: "Ada" });
    const code = String(ctx.tables.signups[0].referral_code);
    const pages: Array<[string, number, Record<string, string>?]> = [
      [`${APP}/`, 200],
      [`${APP}/r/${code}`, 303],
      [`${APP}${statusPath}`, 200],
      [`${APP}/thanks`, 200],
      [`${APP}/admin`, 303],
      [`${APP}/admin`, 200, owner],
      [`${APP}/admin/export.csv`, 200, owner],
      [`${APP}/missing`, 404],
      [`${DEMO}/`, 200]
    ];
    for (const [url, status, headers] of pages) {
      expect((await expectHeadLikeGet(app, ctx, url, { headers })).status).toBe(status);
    }
  });
});

describe("launch-day limits", () => {
  it("shows a plain page and logs an error when the plan's row limit is reached", async () => {
    const ctx = makeCtx(collections, { rowLimit: 1 });
    await join(ctx, APP, { email: "ada@example.com" });
    const full = await post(ctx, `${APP}/join`, { email: "late@example.com" });
    expect(full.status).toBe(503);
    expect(full.headers.get("content-type")).toContain("text/html");
    const html = await full.text();
    expect(html).toContain("The waitlist is full right now.");
    expect(html).not.toContain("quota_exceeded");
    expect(ctx.log.error).toHaveBeenCalledWith("waitlist full", { reason: "quota_exceeded", demo: false });
    expect(JSON.stringify(ctx.log.error.mock.calls)).not.toContain("late@example.com");
  });

  it("saves one signup when the same email joins twice at the same moment", async () => {
    const ctx = makeCtx();
    const responses = await Promise.all(Array.from({ length: 5 }, () => post(ctx, `${APP}/join`, { email: "ada@example.com" })));
    const locations = responses.map((response) => response.headers.get("location") ?? "");
    expect(ctx.tables.signups).toHaveLength(1);
    expect(locations.filter((location) => location.startsWith("/you/"))).toHaveLength(1);
    expect(locations.filter((location) => location === "/thanks")).toHaveLength(4);
  });

  it("reads every page of a long list instead of stopping early", async () => {
    // A stand-in collection with 20,500 rows, 100 per page, like the runtime.
    const total = 20_500;
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => {
      const offset = cursor ? Number(cursor) : 0;
      const rows = Array.from({ length: Math.min(100, total - offset) }, (_, index) => ({ id: `r${offset + index}` }));
      const end = offset + rows.length;
      return { rows, ...(end < total ? { cursor: String(end) } : {}) };
    });
    const rows = await listAll({ list });
    expect(rows).toHaveLength(total);
    expect(list).toHaveBeenCalledTimes(Math.ceil(total / 100));
  });

  it("never shows #NaN when a place in line is missing", () => {
    const html = statusPage({
      site: { robots: "" },
      signup: { id: "row_1", name: "Ada", email: "ada@example.com", status: "waiting", referral_code: "ABCDEFG", referrals: 0, frequency: "", goal: "", city: "" },
      position: undefined,
      waitingCount: 3,
      shareUrl: "https://velto.example.test/r/ABCDEFG",
      statusPath: "/you/row_1/token",
      saved: false
    });
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("first in line");
    expect(html).toContain("Your spot is saved.");
  });
});

describe("referral credit", () => {
  it("counts each inbox once and ignores the referrer's own other spellings", async () => {
    expect(emailKey("A.Da+launch@GoogleMail.com")).toBe("ada@gmail.com");
    expect(emailKey("ada+1@velto.example")).toBe("ada@velto.example");
    expect(emailKey("a.da@velto.example")).toBe("a.da@velto.example");

    const ctx = makeCtx();
    const hostPath = await join(ctx, APP, { email: "host@gmail.com" });
    const code = String(ctx.tables.signups[0].referral_code);
    // The host's own inbox under other spellings earns nothing.
    for (const email of ["host+1@gmail.com", "h.o.s.t@gmail.com", "host+2@googlemail.com"]) await join(ctx, APP, { email, ref: code });
    // One friend under three spellings counts once; a second friend counts too.
    for (const email of ["friend+a@gmail.com", "friend+b@gmail.com", "fr.iend@gmail.com", "other@velto.example"]) await join(ctx, APP, { email, ref: code });
    expect(await (await call(ctx, `${APP}${hostPath}`)).text()).toContain("<b>2</b> friends have joined");

    const counted = withReferralCounts([
      { id: "a", email: "a@x.io", referral_code: "AAAAAA", referred_by: "", status: "waiting" },
      { id: "b", email: "b@x.io", referral_code: "BBBBBB", referred_by: "AAAAAA", status: "archived" }
    ]);
    expect(counted[0].referrals).toBe(0);
  });
});

describe("request details", () => {
  it("answers bad invite links and odd notices without errors", async () => {
    const ctx = makeCtx();
    for (const bad of ["%FF", "%E0%A4%A", "abc%2Fdef"]) {
      const response = await call(ctx, `${APP}/r/${bad}`);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    }
    for (const done of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const html = await (await call(ctx, `${APP}/admin?done=${done}`, { headers: owner })).text();
      expect(html).not.toContain('class="notice"');
      expect(html).not.toContain("native code");
      expect(html).not.toContain("[object Object]");
    }
    const bulkNote = await (await call(ctx, `${APP}/admin?done=archived-many&n=99999&more=1`, { headers: owner })).text();
    expect(bulkNote).toContain(`Archived ${BULK_LIMIT} people. More people match`);
  });

  it("checks the owner role with one session lookup and doesn't hide other failures", async () => {
    const ctx = makeCtx();
    const currentUser = vi.fn(ctx.auth.currentUser);
    const requireRole = vi.fn(ctx.auth.requireRole);
    ctx.auth.currentUser = currentUser;
    ctx.auth.requireRole = requireRole;
    expect((await call(ctx, `${APP}/admin`, { headers: owner })).status).toBe(200);
    expect(currentUser).toHaveBeenCalledTimes(1);
    expect(requireRole).not.toHaveBeenCalled();

    // A storage failure is an error, not an "Owners only" page.
    ctx.auth.currentUser = vi.fn(async () => {
      throw Object.assign(new Error("Storage is unavailable."), { code: "storage_error" });
    });
    await expect(call(ctx, `${APP}/admin`, { headers: owner })).rejects.toThrow("Storage is unavailable.");
  });

  it("rejects owner form posts from other sites, other userland.fun apps, and opaque origins", async () => {
    const ctx = makeCtx();
    await join(ctx, APP, { email: "ada@example.com" });
    const id = ctx.tables.signups[0].id;
    const origins = ["https://evil.example", "https://other-app.apps.userland.fun", "null"];
    for (const origin of origins) {
      for (const [route, fields] of [
        ["status", { status: "archived" }],
        ["link", {}],
        ["delete", {}]
      ] as const) {
        const response = await post(ctx, `${APP}/admin/signups/${id}/${route}`, fields, { ...owner, origin });
        expect(response.status, `${route} from ${origin}`).toBe(400);
      }
      const bulk = await post(ctx, `${APP}/admin/bulk`, { action: "archive", q: "ada" }, { ...owner, origin });
      expect(bulk.status).toBe(400);
      // A sister app's page can't pass itself off as this one with Sec-Fetch-Site either.
      const sameSite = await call(ctx, `${APP}/admin/signups/${id}/status`, {
        method: "POST",
        headers: { ...owner, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-site" },
        body: "status=archived"
      });
      expect(sameSite.status).toBe(400);
    }
    expect(ctx.tables.signups[0]).toMatchObject({ status: "waiting" });
  });
});

describe("owner clean-up and lost links", () => {
  it("gives someone a new private link and turns off the old one", async () => {
    const ctx = makeCtx();
    const oldPath = await join(ctx, APP, { email: "ada@example.com", name: "Ada" });
    const id = ctx.tables.signups[0].id;

    expect((await post(ctx, `${APP}/admin/signups/${id}/link`, {})).status).toBe(303);
    expect((await post(ctx, `${APP}/admin/signups/${id}/link`, {}, { cookie: "__Host-ul_session=helper" })).status).toBe(403);
    expect(await (await call(ctx, `${APP}${oldPath}`)).status).toBe(200);

    const response = await post(ctx, `${APP}/admin/signups/${id}/link`, {}, owner);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    const newPath = new RegExp(`${APP}(/you/${id}/[^"]+)"`, "u").exec(html)?.[1] ?? "";
    expect(newPath).not.toBe("");
    expect(newPath).not.toBe(oldPath);
    expect(html).toContain("Send it to ada@example.com yourself.");
    expect((await call(ctx, `${APP}${oldPath}`)).status).toBe(404);
    expect((await call(ctx, `${APP}${newPath}`)).status).toBe(200);
    expect(ctx.log.info).toHaveBeenCalledWith("waitlist private link replaced", { signup_id: id });
  });

  it("deletes a person for good only after they are archived", async () => {
    const ctx = makeCtx();
    await join(ctx, APP, { email: "junk@example.com" });
    const id = ctx.tables.signups[0].id;

    const early = await post(ctx, `${APP}/admin/signups/${id}/delete`, {}, owner);
    expect(early.status).toBe(409);
    expect(ctx.tables.signups).toHaveLength(1);

    await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "archived" }, owner);
    const archivedView = await (await call(ctx, `${APP}/admin?status=archived`, { headers: owner })).text();
    expect(archivedView).toContain(`action="/admin/signups/${id}/delete"`);

    expect((await post(ctx, `${APP}/admin/signups/${id}/delete`, {}, { cookie: "__Host-ul_session=helper" })).status).toBe(403);
    const deleted = await post(ctx, `${APP}/admin/signups/${id}/delete`, { back: "/admin?status=archived" }, owner);
    expect(deleted.headers.get("location")).toBe("/admin?status=archived&done=deleted");
    expect(ctx.tables.signups).toHaveLength(0);
    expect((await post(ctx, `${APP}/admin/signups/${id}/delete`, {}, owner)).status).toBe(404);
  });

  it("archives many people from a search, a batch at a time, and never the whole list at once", async () => {
    const ctx = makeCtx();
    const signups = ctx.data.collection("signups");
    const at = new Date("2026-09-01T12:00:00Z").toISOString();
    for (let index = 0; index < BULK_LIMIT + 5; index += 1) {
      await signups.create({ email: `bot${index}@spam.example`, status: "waiting", joined_at: at, referral_code: `SPAM${String(index).padStart(3, "0")}`, status_token: "t" });
    }
    await join(ctx, APP, { email: "ada@example.com" });

    const unfiltered = await post(ctx, `${APP}/admin/bulk`, { action: "archive" }, owner);
    expect(unfiltered.status).toBe(400);
    expect(ctx.tables.signups.filter((row) => row.status === "archived")).toHaveLength(0);
    // The owner view only offers the bulk button for a search or filter.
    expect(await (await call(ctx, `${APP}/admin`, { headers: owner })).text()).not.toContain('action="/admin/bulk"');
    const searched = await (await call(ctx, `${APP}/admin?q=spam.example`, { headers: owner })).text();
    expect(searched).toContain(`Archive the first ${BULK_LIMIT} of ${BULK_LIMIT + 5}`);

    const first = await post(ctx, `${APP}/admin/bulk`, { action: "archive", q: "spam.example", back: "/admin?q=spam.example" }, owner);
    expect(first.headers.get("location")).toBe(`/admin?q=spam.example&done=archived-many&n=${BULK_LIMIT}&more=1`);
    const second = await post(ctx, `${APP}/admin/bulk`, { action: "archive", q: "spam.example" }, owner);
    expect(second.headers.get("location")).toBe("/admin?done=archived-many&n=5");
    expect(ctx.tables.signups.filter((row) => row.status === "archived")).toHaveLength(BULK_LIMIT + 5);
    expect(ctx.tables.signups.find((row) => row.email === "ada@example.com")?.status).toBe("waiting");
    expect(ctx.log.info).toHaveBeenCalledWith("waitlist bulk change", { action: "archive", count: 5 });
  });

  it("deletes archived people in batches, even when two clicks land at once", async () => {
    const ctx = makeCtx();
    const signups = ctx.data.collection("signups");
    const at = new Date("2026-09-01T12:00:00Z").toISOString();
    for (let index = 0; index < BULK_LIMIT + 10; index += 1) {
      await signups.create({ email: `bot${index}@spam.example`, status: "archived", joined_at: at, referral_code: `SPAM${String(index).padStart(3, "0")}`, status_token: "t" });
    }
    await join(ctx, APP, { email: "ada@example.com" });
    const archivedView = await (await call(ctx, `${APP}/admin?status=archived`, { headers: owner })).text();
    expect(archivedView).toContain(`Delete the first ${BULK_LIMIT} of ${BULK_LIMIT + 10} for good`);

    const clicks = await Promise.all([1, 2].map(() => post(ctx, `${APP}/admin/bulk`, { action: "delete", status: "archived" }, owner)));
    expect(clicks.map((response) => response.status)).toEqual([303, 303]);
    await post(ctx, `${APP}/admin/bulk`, { action: "delete", status: "archived" }, owner);
    expect(ctx.tables.signups.map((row) => row.email)).toEqual(["ada@example.com"]);
  });
});

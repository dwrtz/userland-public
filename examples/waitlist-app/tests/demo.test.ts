// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you remove demo mode (see README.md).
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { toCsv } from "../server/waitlist.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { sampleSignups } from "../server/demo.js";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
import { APP, DEMO, call, join, makeCtx, owner, post } from "./helpers.js";

describe("public demo", () => {
  it("shows sample signups without sign-in and marks every page as a demo", async () => {
    const ctx = makeCtx();
    for (const path of ["/", "/admin", "/thanks", "/missing"]) {
      const html = await (await call(ctx, `${DEMO}${path}`)).text();
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
      expect(html).toContain('href="https://userland.fun/examples/waitlist-app/"');
    }
    const admin = await (await call(ctx, `${DEMO}/admin`)).text();
    expect(admin).toContain("@example.com");
    expect(admin).toContain("people");

    // The landing count leaves out the samples the owner archived.
    const archived = sampleSignups().filter((row: { status: string }) => row.status === "archived").length;
    expect(archived).toBeGreaterThan(0);
    expect(await (await call(ctx, `${DEMO}/`)).text()).toContain(`<b>${sampleSignups().length - archived}</b> runners have already joined.`);
  });

  it("keeps the visitor's demo on message pages", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "gus@example.com" });
    const key = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";

    const repeat = await post(ctx, `${DEMO}/join`, { email: "gus@example.com", demo: key });
    expect(repeat.headers.get("location")).toBe(`/thanks?demo=${key}`);
    for (const page of [`/thanks?demo=${key}`, `/missing?demo=${key}`]) {
      const html = await (await call(ctx, `${DEMO}${page}`)).text();
      expect(html).toContain(`class="button button--volt" href="/?demo=${key}"`);
      expect(html).toContain(`<a href="/?demo=${key}">Go to the waitlist page</a>`);
    }
    // The answers form carries the demo key, so a failed answers post still links back to it.
    const statusHtml = await (await call(ctx, `${DEMO}${path}`)).text();
    expect(statusHtml).toContain(`class="questions"><input type="hidden" name="demo" value="${key}">`);
    const badAnswers = await post(ctx, `${DEMO}${path.replace(/[^/]+$/u, "wrong-token")}/answers`, { demo: key });
    expect(badAnswers.status).toBe(404);
    expect(await badAnswers.text()).toContain(`class="button button--volt" href="/?demo=${key}"`);
    const badChange = await post(ctx, `${DEMO}/admin/signups/x/status`, { status: "nope", demo: key });
    expect(badChange.status).toBe(400);
    expect(await badChange.text()).toContain(`href="/admin?demo=${key}"`);
  });

  it("deletes visitor signups after a day and caps the demo as a whole", async () => {
    const ctx = makeCtx();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-01T12:00:00Z") });
    const oldPath = await join(ctx, DEMO, { email: "old@example.com" });
    const oldKey = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${oldPath}`)).text())?.[1] ?? "";
    expect(ctx.tables["demo-signups"][0].demo_expires_at).toBe("2026-09-02T12:00:00.000Z");

    // A day later the old signup is gone from its owner's view, and the next write deletes it.
    vi.setSystemTime(new Date("2026-09-02T12:05:00Z"));
    expect(await (await call(ctx, `${DEMO}/admin?demo=${oldKey}&sort=newest`)).text()).not.toContain("old@example.com");
    await join(ctx, DEMO, { email: "new@example.com" });
    expect(ctx.tables["demo-signups"].map((row) => row.email)).toEqual(["new@example.com"]);

    // Fill the demo to its limit (MAX_DEMO_ROWS = 400) with other visitors' rows.
    const rows = ctx.data.collection("demo-signups");
    for (let index = 0; index < 399; index += 1) {
      await rows.create({ demo_key: `k${index}`, email: `v${index}@example.com`, demo_expires_at: "2026-09-03T12:00:00.000Z" });
    }
    const full = await post(ctx, `${DEMO}/join`, { email: "late@example.com" });
    expect(full.status).toBe(429);
    expect(await full.text()).toContain("The demo is busy right now.");
    expect(ctx.tables["demo-signups"]).toHaveLength(400);
    vi.useRealTimers();
  });

  it("never shows one visitor's signups to another visitor", async () => {
    const ctx = makeCtx();
    const alicePath = await join(ctx, DEMO, { email: "alice@example.com", name: "Alice" });
    const bobPath = await join(ctx, DEMO, { email: "bob@example.com", name: "Bob" });

    const keyFrom = async (path: string) => /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";
    const aliceKey = await keyFrom(alicePath);
    const bobKey = await keyFrom(bobPath);
    expect(aliceKey).not.toBe("");
    expect(aliceKey).not.toBe(bobKey);

    const aliceView = await (await call(ctx, `${DEMO}/admin?demo=${aliceKey}&sort=newest`)).text();
    expect(aliceView).toContain("alice@example.com");
    expect(aliceView).not.toContain("bob@example.com");

    const bobView = await (await call(ctx, `${DEMO}/admin?demo=${bobKey}&sort=newest`)).text();
    expect(bobView).toContain("bob@example.com");
    expect(bobView).not.toContain("alice@example.com");

    // The CSV holds every row in the view, so it checks the whole list, not just one page.
    const exportFor = async (query: string) => await (await call(ctx, `${DEMO}/admin/export.csv${query}`)).text();
    expect(await exportFor(`?demo=${aliceKey}`)).toContain("alice@example.com");
    expect(await exportFor(`?demo=${aliceKey}`)).not.toContain("bob@example.com");
    expect(await exportFor(`?demo=${bobKey}`)).not.toContain("alice@example.com");
    const anonymous = await exportFor("");
    expect(anonymous).not.toContain("alice@example.com");
    expect(anonymous).not.toContain("bob@example.com");
    for (const path of ["/", "/admin", "/admin?sort=newest"]) {
      const html = await (await call(ctx, `${DEMO}${path}`)).text();
      expect(html).not.toContain("alice@example.com");
      expect(html).not.toContain("bob@example.com");
    }

    // Bob cannot change Alice's signup even with its id.
    const aliceId = ctx.tables["demo-signups"].find((row) => row.email === "alice@example.com")?.id;
    const attempt = await post(ctx, `${DEMO}/admin/signups/${aliceId}/status`, { status: "archived", demo: bobKey });
    expect(attempt.status).toBe(404);
    expect(ctx.tables["demo-signups"].find((row) => row.id === aliceId)?.status).toBe("waiting");

    // Nothing from the demo lands in the real signups collection.
    expect(ctx.tables.signups ?? []).toHaveLength(0);
  });

  it("keeps status changes on sample signups private to the visitor", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "carol@example.com" });
    const key = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";
    const sample = sampleSignups().find((row: { status: string }) => row.status === "waiting");

    const response = await post(ctx, `${DEMO}/admin/signups/${sample.id}/status`, { status: "invited", demo: key });
    expect(response.headers.get("location")).toBe(`/admin?done=invited&demo=${key}`);

    const invited = async (query: string) => await (await call(ctx, `${DEMO}/admin/export.csv?status=invited${query}`)).text();
    expect(await invited(`&demo=${key}`)).toContain(sample.email);
    expect(await invited("")).not.toContain(sample.email);
    const otherVisitor = await join(ctx, DEMO, { email: "dave@example.com" });
    const otherKey = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${otherVisitor}`)).text())?.[1] ?? "";
    expect(await invited(`&demo=${otherKey}`)).not.toContain(sample.email);
  });

  it("lets a visitor test their invite link inside their own demo", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "dana@example.com", name: "Dana" });
    const html = await (await call(ctx, `${DEMO}${path}`)).text();
    const key = /demo=([a-f0-9]{32})/u.exec(html)?.[1] ?? "";
    const code = /\/r\/([A-Z0-9]+)/u.exec(html)?.[1] ?? "";

    // The private page explains that shared links start a separate demo, and links to the one that works.
    expect(html).toContain('class="demo-tip"');
    expect(html).toContain(`href="/?ref=${code}&amp;demo=${key}"`);
    // The logo keeps the visitor's demo.
    expect(html).toContain(`class="logo" href="/?demo=${key}"`);

    await join(ctx, DEMO, { email: "erin@example.com", ref: code, demo: key });
    expect(await (await call(ctx, `${DEMO}${path}`)).text()).toContain("<b>1</b> friend has joined");

    // The same link used by someone without this visitor's demo key does not reach their list.
    await join(ctx, DEMO, { email: "stranger@example.com", ref: code });
    expect(await (await call(ctx, `${DEMO}${path}`)).text()).toContain("<b>1</b> friend has joined");
  });
});

describe("demo samples", () => {
  it("builds made-up sample signups with example.com emails only", () => {
    const samples = sampleSignups(new Date("2026-09-27T12:00:00Z"));
    expect(samples.length).toBeGreaterThan(100);
    expect(samples.every((row: { email: string }) => row.email.endsWith("@example.com"))).toBe(true);
    expect(new Set(samples.map((row: { email: string }) => row.email)).size).toBe(samples.length);
    expect(toCsv([], new Map())).toContain("place_in_line");
  });
});

describe("demo pages", () => {
  it("answer HEAD like GET, including the owner view", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "gus@example.com" });
    const key = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";
    expect(key).not.toBe("");
    const pages: Array<[string, number]> = [
      [`${DEMO}${path}`, 200],
      [`${DEMO}/thanks?demo=${key}`, 200],
      [`${DEMO}/admin`, 200],
      [`${DEMO}/admin?demo=${key}&sort=newest`, 200],
      [`${DEMO}/admin/export.csv?demo=${key}`, 200]
    ];
    for (const [url, status] of pages) {
      expect((await expectHeadLikeGet(app, ctx, url)).status).toBe(status);
    }
  });

  it("turns off a private link once its day is up, even before the cleanup runs", async () => {
    const ctx = makeCtx();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-01T12:00:00Z") });
    const path = await join(ctx, DEMO, { email: "old@example.com" });
    expect((await call(ctx, `${DEMO}${path}`)).status).toBe(200);
    vi.setSystemTime(new Date("2026-09-02T12:05:00Z"));
    // The row is still stored (nothing has written since), but its page is gone, not "#NaN".
    expect(ctx.tables["demo-signups"]).toHaveLength(1);
    const expired = await call(ctx, `${DEMO}${path}`);
    expect(expired.status).toBe(404);
    expect(await expired.text()).not.toContain("NaN");
    vi.useRealTimers();
  });

  it("explains that deleting is off, and still makes new private links", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "hal@example.com" });
    const key = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";
    const id = ctx.tables["demo-signups"][0].id;

    await post(ctx, `${DEMO}/admin/signups/${id}/status`, { status: "archived", demo: key });
    const refused = await post(ctx, `${DEMO}/admin/signups/${id}/delete`, { demo: key });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Deleting is off in the demo.");
    const bulk = await post(ctx, `${DEMO}/admin/bulk`, { action: "delete", status: "archived", demo: key });
    expect(bulk.status).toBe(403);
    expect(ctx.tables["demo-signups"]).toHaveLength(1);

    await post(ctx, `${DEMO}/admin/signups/${id}/status`, { status: "waiting", demo: key });
    const link = await post(ctx, `${DEMO}/admin/signups/${id}/link`, { demo: key });
    expect(link.status).toBe(200);
    const newPath = new RegExp(`${DEMO}(/you/${id}/[^"]+)"`, "u").exec(await link.text())?.[1] ?? "";
    expect(newPath).not.toBe("");
    expect((await call(ctx, `${DEMO}${path}`)).status).toBe(404);
    expect((await call(ctx, `${DEMO}${newPath}`)).status).toBe(200);
  });
});

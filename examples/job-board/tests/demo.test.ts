// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you remove the demo (see README.md).
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { DEMO_HOSTS, demoMode } from "../server/demo.js";
import { APP_ORIGIN, DEMO_ORIGIN, countingCtx, get, makeCtx, post, validListing, type Ctx } from "./helpers.js";

describe("public demo", () => {
  async function visitorPosts(ctx: Ctx, title: string) {
    const response = await post(app, ctx, `${DEMO_ORIGIN}/post`, { ...validListing, title, contact_email: `${title.split(" ")[0].toLowerCase()}@example.com` });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    const key = new URL(location, DEMO_ORIGIN).searchParams.get("demo");
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    return key as string;
  }

  it("marks every page noindex and links back to the example page", async () => {
    const ctx = makeCtx();
    for (const path of ["/", "/jobs/orchard-crew-lead", "/post", "/owner", "/nope"]) {
      const body = await (await get(app, ctx, `${DEMO_ORIGIN}${path}`)).text();
      expect(body).toContain('<meta name="robots" content="noindex,follow">');
      expect(body).toContain('href="https://userland.fun/examples/job-board/"');
      expect(body).toContain("Built with Userland");
    }
  });

  it("opens the owner view without sign-in and shows sample listings", async () => {
    const ctx = makeCtx();
    const response = await get(app, ctx, `${DEMO_ORIGIN}/owner`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Pasture poultry crew");
    expect(body).toContain("On a real board, this page asks the owner to sign in first.");
  });

  it("never shows one visitor's listings to another", async () => {
    const ctx = makeCtx();
    const alice = await visitorPosts(ctx, "Alice goat herder");
    const bob = await visitorPosts(ctx, "Bob bee keeper");

    const aliceOwner = await (await get(app, ctx, `${DEMO_ORIGIN}/owner?demo=${alice}&tab=all`)).text();
    expect(aliceOwner).toContain("Alice goat herder");
    expect(aliceOwner).toContain("alice@example.com");
    expect(aliceOwner).not.toContain("Bob bee keeper");
    expect(aliceOwner).not.toContain("bob@example.com");

    const bobOwner = await (await get(app, ctx, `${DEMO_ORIGIN}/owner?demo=${bob}&tab=all`)).text();
    expect(bobOwner).toContain("Bob bee keeper");
    expect(bobOwner).not.toContain("Alice goat herder");

    const stranger = await (await get(app, ctx, `${DEMO_ORIGIN}/owner?tab=all`)).text();
    expect(stranger).not.toContain("Alice goat herder");
    expect(stranger).not.toContain("Bob bee keeper");

    // Bob can't open or change Alice's listing by guessing its id.
    const aliceId = ctx.state["demo-listings"].find((row) => row.title === "Alice goat herder")?.id;
    expect((await get(app, ctx, `${DEMO_ORIGIN}/owner/jobs/${aliceId}?demo=${bob}`)).status).toBe(404);
    expect((await post(app, ctx, `${DEMO_ORIGIN}/owner/jobs/${aliceId}/status?demo=${bob}`, { status: "approved" })).status).toBe(404);
    expect(ctx.state["demo-listings"].find((row) => row.id === aliceId)).toMatchObject({ status: "pending" });
  });

  it("keeps approvals and declines inside the visitor's own copy of the board", async () => {
    const ctx = makeCtx();
    const alice = await visitorPosts(ctx, "Alice goat herder");
    const aliceId = ctx.state["demo-listings"][0].id;

    await post(app, ctx, `${DEMO_ORIGIN}/owner/jobs/${aliceId}/status?demo=${alice}`, { status: "approved" });
    await post(app, ctx, `${DEMO_ORIGIN}/owner/jobs/orchard-crew-lead/status?demo=${alice}`, { status: "closed" });

    const aliceBoard = await (await get(app, ctx, `${DEMO_ORIGIN}/?demo=${alice}`)).text();
    expect(aliceBoard).toContain("Alice goat herder");
    expect(aliceBoard).not.toContain("Orchard crew lead");

    const everyoneElse = await (await get(app, ctx, `${DEMO_ORIGIN}/`)).text();
    expect(everyoneElse).not.toContain("Alice goat herder");
    expect(everyoneElse).toContain("Orchard crew lead");
    expect((await get(app, ctx, `${DEMO_ORIGIN}/jobs/${aliceId}`)).status).toBe(404);
  });

  const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const later = () => new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  async function seedDemoRows(ctx: Ctx, count: number, fields: Record<string, unknown>) {
    const rows = ctx.data.collection("demo-listings");
    for (let index = 0; index < count; index += 1) {
      await rows.create({ ...validListing, title: `${String(fields.title ?? "Row")} ${index}`, source_id: "", status: "pending", submitted_at: past(), ...fields });
    }
  }

  it("clears day-old visitor listings even when many newer ones exist", async () => {
    const ctx = makeCtx();
    // 150 fresh rows first, then 3 expired ones at the end of the list.
    await seedDemoRows(ctx, 150, { title: "Fresh", visitor: "x", expires_at: later() });
    await seedDemoRows(ctx, 3, { title: "Old", visitor: "y", expires_at: past() });

    await visitorPosts(ctx, "Carmen cider maker");

    const rows = ctx.state["demo-listings"];
    expect(rows.some((row) => String(row.title).startsWith("Old"))).toBe(false);
    expect(rows.filter((row) => String(row.title).startsWith("Fresh"))).toHaveLength(150);
    expect(rows.find((row) => row.title === "Carmen cider maker")?.expires_at).toEqual(expect.any(String));
  });

  it("clears expired listings on page views too, and never shows them", async () => {
    const ctx = makeCtx();
    const alice = await visitorPosts(ctx, "Alice goat herder");
    // A day later: Alice's listing has expired, and no one has saved anything since.
    await ctx.data.collection("demo-listings").update(ctx.state["demo-listings"][0].id, { expires_at: past() });

    const owner = await (await get(app, ctx, `${DEMO_ORIGIN}/owner?demo=${alice}&tab=all`)).text();
    expect(owner).not.toContain("Alice goat herder");
    expect(ctx.state["demo-listings"]).toHaveLength(0);
  });

  const active = (ctx: Ctx) => ctx.state["demo-listings"].filter((row) => String(row.expires_at) > new Date().toISOString()).length;

  it("caps the whole demo by dropping the oldest rows, so a flood can't fill storage or lock visitors out", async () => {
    const ctx = makeCtx();
    // A script posts 230 listings without a key: each gets a brand-new key, so
    // only the demo-wide cap applies.
    for (let index = 0; index < 230; index += 1) {
      const response = await post(app, ctx, `${DEMO_ORIGIN}/post`, { ...validListing, title: `Scripted ${index}` });
      expect(response.status).toBe(303);
    }
    expect(ctx.state["demo-listings"]).toHaveLength(200);
    expect(ctx.state["demo-listings"].some((row) => row.title === "Scripted 0")).toBe(false);
    expect(ctx.state["demo-listings"].some((row) => row.title === "Scripted 229")).toBe(true);

    // A new visitor can still post and make owner changes.
    const carmen = await visitorPosts(ctx, "Carmen cider maker");
    const change = await post(app, ctx, `${DEMO_ORIGIN}/owner/jobs/egg-crew/status?demo=${carmen}`, { status: "approved" });
    expect(change.status).toBe(303);
    const board = await (await get(app, ctx, `${DEMO_ORIGIN}/?demo=${carmen}`)).text();
    expect(board).toContain("Pasture poultry crew");
    expect(ctx.state["demo-listings"]).toHaveLength(200);
  });

  it("holds the demo-wide cap when many saves arrive at the same moment", async () => {
    const ctx = makeCtx();
    await seedDemoRows(ctx, 190, { title: "Earlier", visitor: "", expires_at: later() });
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => post(app, ctx, `${DEMO_ORIGIN}/post`, { ...validListing, title: `Burst ${index}` })));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 303).length).toBeGreaterThan(0);
    expect(statuses.every((status) => status === 303 || status === 429)).toBe(true);
    expect(await responses.find((response) => response.status === 429)?.text()).toContain("The demo is busy");
    expect(active(ctx)).toBeLessThanOrEqual(202);

    // Expired rows don't count toward the cap and are cleared a few at a time.
    for (const row of ctx.state["demo-listings"].slice(0, 5)) await ctx.data.collection("demo-listings").update(row.id, { expires_at: past() });
    expect((await post(app, ctx, `${DEMO_ORIGIN}/post`, validListing)).status).toBe(303);
    expect(ctx.state["demo-listings"].filter((row) => String(row.expires_at) <= new Date().toISOString())).toHaveLength(0);
  });

  it("gets back under the cap after a big burst, so later visitors aren't stuck on the busy page", async () => {
    const ctx = makeCtx();
    await seedDemoRows(ctx, 150, { title: "Earlier", visitor: "", expires_at: later() });
    const burst = await Promise.all(Array.from({ length: 200 }, (_, index) => post(app, ctx, `${DEMO_ORIGIN}/post`, { ...validListing, title: `Flood ${index}` })));
    expect(burst.every((response) => response.status === 303 || response.status === 429)).toBe(true);

    // Each later save trims a few of the newest extra rows until the demo is
    // back under the cap; then saves go through again.
    const statuses: number[] = [];
    while (statuses.at(-1) !== 303 && statuses.length < 25) {
      statuses.push((await post(app, ctx, `${DEMO_ORIGIN}/post`, { ...validListing, title: "Later visitor" })).status);
    }
    expect(statuses.at(-1)).toBe(303);
    expect(statuses.every((status) => status === 303 || status === 429)).toBe(true);
    expect(active(ctx)).toBeLessThanOrEqual(200);
    // The burst took back its own extra rows instead of wiping out everyone
    // else's; only the last save's usual "drop the oldest" touched them.
    expect(ctx.state["demo-listings"].filter((row) => row.title === "Earlier").length).toBeGreaterThanOrEqual(148);
  }, 20_000);

  it("keeps each visitor to 30 saved changes", async () => {
    const ctx = makeCtx();
    const alice = await visitorPosts(ctx, "Alice goat herder");
    await seedDemoRows(ctx, 29, { title: "Alice extra", visitor: alice, expires_at: later() });
    const response = await post(app, ctx, `${DEMO_ORIGIN}/post?demo=${alice}`, validListing);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("up to 30 changes per visit");
  });

  it("shows the busy page instead of an error if the demo runs out of room", async () => {
    const ctx = makeCtx();
    const rows = ctx.data.collection("demo-listings");
    const quotaCtx = {
      ...ctx,
      data: {
        ...ctx.data,
        collection: (name: string) => ({
          ...rows,
          async create() {
            throw Object.assign(new Error("quota exceeded"), { code: "quota_exceeded" });
          }
        })
      }
    } as Ctx;
    await seedDemoRows(ctx, 3, { title: "Oldest", visitor: "", expires_at: later() });
    const response = await post(app, quotaCtx, `${DEMO_ORIGIN}/post`, validListing);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("Please try again in a minute.");
    // It also frees a little room, so the next try can go through.
    expect(ctx.state["demo-listings"]).toHaveLength(1);
  });

  it("lets a visitor delete listings in their own copy only", async () => {
    const ctx = makeCtx();
    const alice = await visitorPosts(ctx, "Alice goat herder");
    const aliceId = ctx.state["demo-listings"][0].id;

    expect((await post(app, ctx, `${DEMO_ORIGIN}/owner/jobs/${aliceId}/delete?demo=${alice}`, {})).status).toBe(303);
    expect((await post(app, ctx, `${DEMO_ORIGIN}/owner/jobs/orchard-crew-lead/delete?demo=${alice}`, {})).status).toBe(303);
    expect((await post(app, ctx, `${DEMO_ORIGIN}/owner/declined/delete?demo=${alice}`, {})).status).toBe(303);

    const aliceOwner = await (await get(app, ctx, `${DEMO_ORIGIN}/owner?demo=${alice}&tab=all`)).text();
    expect(aliceOwner).not.toContain("Alice goat herder");
    expect(aliceOwner).not.toContain("Orchard crew lead");
    expect(aliceOwner).not.toContain("Earn $5,000");
    expect((await get(app, ctx, `${DEMO_ORIGIN}/jobs/orchard-crew-lead?demo=${alice}`)).status).toBe(404);

    const everyoneElse = await (await get(app, ctx, `${DEMO_ORIGIN}/owner?tab=all`)).text();
    expect(everyoneElse).toContain("Orchard crew lead");
    expect(everyoneElse).toContain("Earn $5,000");
  });

  it("deletes declined listings in a few data calls, even with many of them", async () => {
    const ctx = makeCtx();
    const alice = await visitorPosts(ctx, "Alice goat herder");
    for (let index = 1; index < 16; index += 1) {
      expect((await post(app, ctx, `${DEMO_ORIGIN}/post?demo=${alice}`, { ...validListing, title: `Alice extra ${index}` })).status).toBe(303);
    }
    for (const row of [...ctx.state["demo-listings"]]) {
      expect((await post(app, ctx, `${DEMO_ORIGIN}/owner/jobs/${row.id}/status?demo=${alice}`, { status: "rejected" })).status).toBe(303);
    }
    await seedDemoRows(ctx, 10, { title: "Expired", visitor: "someone", expires_at: past() });

    const counted = countingCtx(ctx);
    const first = await post(app, counted.ctx, `${DEMO_ORIGIN}/owner/declined/delete?demo=${alice}`, {});
    expect(first.status).toBe(303);
    expect(counted.total()).toBeLessThanOrEqual(16);
    expect(first.headers.get("location")).toContain("more=1");

    counted.reset();
    const second = await post(app, counted.ctx, `${DEMO_ORIGIN}/owner/declined/delete?demo=${alice}`, {});
    expect(second.status).toBe(303);
    expect(counted.total()).toBeLessThanOrEqual(16);
    const owner = await (await get(app, ctx, `${DEMO_ORIGIN}/owner?demo=${alice}&tab=rejected`)).text();
    expect(owner).not.toContain("Alice");
    expect(owner).not.toContain("Earn $5,000");
  });

  it("keeps demo mode off on any host other than the demo host", async () => {
    const ctx = makeCtx();
    const response = await get(app, ctx, `${APP_ORIGIN}/owner`);
    expect(response.status).toBe(303);
    expect((await post(app, ctx, `${APP_ORIGIN}/post`, validListing)).status).toBe(303);
    expect(ctx.state.listings).toHaveLength(1);
    expect(ctx.state["demo-listings"]).toHaveLength(0);
  });

  it("turns demo mode on at the demo's addresses on both apps.userland.fun and userland.link", async () => {
    const ctx = makeCtx();
    const hosts = ["job-board-demo.apps.userland.fun", "4fz14jppml2y13cxqx1.apps.userland.fun", "job-board-demo.userland.link", "4fz14jppml2y13cxqx1.userland.link"];
    expect([...DEMO_HOSTS].sort()).toEqual([...hosts].sort());
    for (const host of hosts) {
      const owner = await get(app, ctx, `https://${host}/owner`);
      expect(owner.status, host).toBe(200);
      expect(await owner.text(), host).toContain("noindex");
    }
    for (const host of ["example-check.userland.link", "example-check.apps.userland.fun"]) {
      expect((await get(app, ctx, `https://${host}/owner`)).status, host).toBe(303);
    }
  });

  it("answers HEAD like GET on demo pages without saving anything", async () => {
    const ctx = makeCtx();
    for (const path of ["/", "/owner", "/owner/jobs/orchard-crew-lead", "/owner/jobs/orchard-crew-lead/delete", "/jobs/orchard-crew-lead"]) {
      expect((await expectHeadLikeGet(app, ctx, `${DEMO_ORIGIN}${path}`)).status).toBe(200);
    }
    expect(ctx.state["demo-listings"]).toHaveLength(0);
  });

  it("ignores malformed visitor keys", async () => {
    const ctx = makeCtx();
    const response = await get(app, ctx, `${DEMO_ORIGIN}/owner?demo=${encodeURIComponent("<script>")}`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain("demo=%3Cscript");
    expect(demoMode.visitorFrom(new URL(`${DEMO_ORIGIN}/?demo=short`))).toBeNull();
  });
});

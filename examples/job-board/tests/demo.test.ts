// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you remove the demo (see README.md).
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { createApp } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { demoMode } from "../server/demo.js";
import { APP_ORIGIN, DEMO_ORIGIN, get, makeCtx, post, production, seedApproved, validListing, type Ctx } from "./helpers.js";

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

  it("clears day-old visitor listings even when many newer ones exist", async () => {
    const ctx = makeCtx();
    const rows = ctx.state["demo-listings"];
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    // 250 fresh rows first, then 3 expired ones at the end of the list.
    for (let index = 0; index < 250; index += 1) rows.push({ id: `fresh_${index}`, created_at: past, updated_at: past, visitor: "x", expires_at: later });
    for (let index = 0; index < 3; index += 1) rows.push({ id: `old_${index}`, created_at: past, updated_at: past, visitor: "y", expires_at: past });

    await visitorPosts(ctx, "Carmen cider maker");

    expect(rows.some((row) => row.id.startsWith("old_"))).toBe(false);
    expect(rows.filter((row) => row.id.startsWith("fresh_"))).toHaveLength(250);
    expect(rows.find((row) => row.title === "Carmen cider maker")?.expires_at).toEqual(expect.any(String));
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

// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you turn demo mode off (see README.md).
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { createApp } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { DEMO_LIMITS, demo } from "../server/demo.js";
import { ORIGIN, demoKey, get, makeCtx, post, request } from "./helpers.js";

describe("demo mode", () => {
  it("shows sample leads to visitors without signing in, marked noindex with a link back", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();
    for (const path of ["/", "/thanks", "/admin", "/admin/leads/new", "/admin/leads/sample-maya", "/missing"]) {
      const body = await (await get(app, ctx, path)).text();
      expect(body, path).toContain('<meta name="robots" content="noindex,follow">');
      expect(body, path).toContain('href="https://userland.fun/examples/mini-crm/"');
    }
    const board = await (await get(app, ctx, "/admin")).text();
    expect(board).toContain("Maya Okafor");
    expect(ctx.auth.currentUser).not.toHaveBeenCalled();
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("asks for made-up details and never promises more privacy than a link gives", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();

    const home = await (await get(app, ctx, "/")).text();
    expect(home).toContain("nobody will contact you");
    expect(home).toContain("Please use made-up details.");
    expect(home).toContain("Anyone with this page's link can see what you add.");
    expect(home).not.toContain("We only use your details");
    expect(home).not.toContain("Start a new demo");

    // Nothing saved yet: the thanks page doesn't claim a request arrived.
    const plainThanks = await (await get(app, ctx, "/thanks")).text();
    expect(plainThanks).toContain("Open the lead board to see sample leads");
    expect(plainThanks).not.toContain("Your request is on the owner's lead board");
    expect(plainThanks).toContain("nobody will contact you");

    const sent = await post(app, ctx, "/estimate", request);
    const key = demoKey(sent);
    const thanks = await (await get(app, ctx, `/thanks?demo=${key}`)).text();
    expect(thanks).toContain("Your request is on the owner's lead board");
    expect(thanks).toContain("anyone you share that link with can see it too");

    // A page opened from someone's demo link says so and offers a clean start.
    const linked = await (await get(app, ctx, `/?demo=${key}`)).text();
    expect(linked).toContain('<a href="/">Start a new demo</a>');

    for (const body of [home, plainThanks, thanks, await (await get(app, ctx, "/admin")).text()]) {
      expect(body).not.toContain("kept separate");
      expect(body).not.toContain("Only you can see");
    }
  });

  it("keeps each visitor's entries away from other visitors", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();

    const first = await post(app, ctx, "/estimate", { ...request, name: "Visitor Alpha" });
    const alpha = demoKey(first);
    expect(alpha).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.headers.get("location")).toBe(`/thanks?demo=${alpha}`);

    const second = await post(app, ctx, "/estimate", { ...request, name: "Visitor Bravo" });
    const bravo = demoKey(second);
    expect(bravo).not.toBe(alpha);

    const alphaBoard = await (await get(app, ctx, `/admin?demo=${alpha}`)).text();
    expect(alphaBoard).toContain("Visitor Alpha");
    expect(alphaBoard).not.toContain("Visitor Bravo");
    expect(alphaBoard).toContain(`demo=${alpha}`);

    const bravoBoard = await (await get(app, ctx, `/admin?demo=${bravo}`)).text();
    expect(bravoBoard).toContain("Visitor Bravo");
    expect(bravoBoard).not.toContain("Visitor Alpha");

    const anonymous = await (await get(app, ctx, "/admin")).text();
    expect(anonymous).not.toContain("Visitor Alpha");
    expect(anonymous).not.toContain("Visitor Bravo");

    // Knowing another visitor's lead id is not enough to open it.
    const alphaLead = ctx.state.leads.find((row) => row.name === "Visitor Alpha")!;
    expect((await get(app, ctx, `/admin/leads/${alphaLead.id}?demo=${bravo}`)).status).toBe(404);
    expect((await get(app, ctx, `/admin/leads/${alphaLead.id}`)).status).toBe(404);
    expect((await post(app, ctx, `/admin/leads/${alphaLead.id}/notes`, { body: "hi", demo: bravo })).status).toBe(404);
    expect((await get(app, ctx, `/admin/leads/${alphaLead.id}?demo=${alpha}`)).status).toBe(200);
  });

  it("applies changes to sample leads for one visitor only", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();

    const moved = await post(app, ctx, "/admin/leads/sample-maya/stage", { stage: "won", follow_up_on: "" });
    expect(moved.status).toBe(303);
    const key = demoKey(moved);
    expect(moved.headers.get("location")).toBe(`/admin/leads/sample-maya?saved=update&demo=${key}`);
    await post(app, ctx, "/admin/leads/sample-maya/notes", { body: "Signed today.", demo: key });

    const mine = await (await get(app, ctx, `/admin/leads/sample-maya?demo=${key}`)).text();
    expect(mine).toContain('class="chip chip-won"');
    expect(mine).toContain("Signed today.");

    const someoneElse = await (await get(app, ctx, "/admin/leads/sample-maya")).text();
    expect(someoneElse).toContain('class="chip chip-new"');
    expect(someoneElse).not.toContain("Signed today.");
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("caps how much one visitor can save", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();
    const first = await post(app, ctx, "/estimate", request);
    const key = demoKey(first);
    for (let index = 1; index < DEMO_LIMITS.leads; index += 1) {
      expect((await post(app, ctx, "/estimate", { ...request, demo: key })).status).toBe(303);
    }
    const over = await post(app, ctx, "/estimate", { ...request, demo: key });
    expect(over.status).toBe(429);
    expect(await over.text()).toContain("That&#39;s plenty for a demo");
    expect(ctx.state.leads).toHaveLength(DEMO_LIMITS.leads);
    // Every lead kept its history row: a refused save never stops halfway.
    expect(ctx.state.activity).toHaveLength(DEMO_LIMITS.leads);
  });

  it("stops taking new entries once the whole demo is full", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();
    // Fill the demo with history rows from many earlier visitors.
    for (let index = 0; index < DEMO_LIMITS.everyone; index += 1) {
      await ctx.data.collection("activity").create({ lead_id: "sample-maya", lead_name: "Maya Okafor", kind: "note", body: "Earlier visitor", demo_visitor: `visitor${String(index).padStart(15, "0")}` });
    }
    const response = await post(app, ctx, "/estimate", request);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("The demo is full for now");
    expect(ctx.state.leads).toHaveLength(0);

    const note = await post(app, ctx, "/admin/leads/sample-maya/notes", { body: "One more" });
    expect(note.status).toBe(429);
    expect(ctx.state.activity).toHaveLength(DEMO_LIMITS.everyone);

    // Looking around still works.
    expect((await get(app, ctx, "/admin")).status).toBe(200);
  });
});

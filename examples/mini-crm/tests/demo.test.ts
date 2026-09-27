// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you turn demo mode off (see README.md).
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { createApp } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { DEMO_HOSTS, DEMO_KEEP_HOURS, DEMO_LIMITS, SWEEP_BATCH, demo } from "../server/demo.js";
import { DEMO_ORIGIN, type Ctx, at, demoKey, makeCtx, request } from "./helpers.js";

// Demo mode only turns on at the public demo's addresses.
const { get, post } = at(DEMO_ORIGIN);
const HOUR = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
});

/** Rows other visitors saved, straight into the activity collection. */
async function seedEntries(ctx: Ctx, count: number, { savedAt = new Date().toISOString(), legacy = false } = {}) {
  for (let index = 0; index < count; index += 1) {
    await ctx.data.collection("activity").create({
      lead_id: "sample-maya",
      lead_name: "Maya Okafor",
      kind: "note",
      body: "Earlier visitor",
      demo_visitor: `visitor${String(index).padStart(15, "0")}`,
      // Older versions of the demo saved rows without demo_saved_at.
      ...(legacy ? {} : { demo_saved_at: savedAt })
    });
  }
}

describe("demo mode", () => {
  it("turns on in the published app only at the demo's addresses", async () => {
    expect([...DEMO_HOSTS]).toContain(new URL(DEMO_ORIGIN).hostname);
    for (const host of DEMO_HOSTS) {
      const ctx = makeCtx();
      const board = await at(`https://${host}`).get(app, ctx, "/admin");
      expect(board.status, host).toBe(200);
      expect(await board.text(), host).toContain("Maya Okafor");
      expect(ctx.auth.currentUser).not.toHaveBeenCalled();
    }
  });

  it("answers HEAD like GET, without a body", async () => {
    const ctx = makeCtx();
    for (const pathname of ["/", "/admin"]) {
      expect((await expectHeadLikeGet(app, ctx, `${DEMO_ORIGIN}${pathname}`)).status).toBe(200);
    }
  });

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
    expect(board).toContain(`All<span class="tab-count">9</span>`);
    expect(ctx.auth.currentUser).not.toHaveBeenCalled();
    expect(ctx.state.leads).toHaveLength(0);
    expect(ctx.state.activity).toHaveLength(0);
  });

  it("asks for made-up details and never promises more privacy than a link gives", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();

    const home = await (await get(app, ctx, "/")).text();
    expect(home).toContain("nobody will contact you");
    expect(home).toContain("Please use made-up details.");
    expect(home).toContain("Anyone with this page's link can see what you add.");
    expect(home).toContain(`Demo entries are removed after ${DEMO_KEEP_HOURS} hours.`);
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

    // The demo saves history rows only, never real leads.
    expect(ctx.state.leads).toHaveLength(0);

    const alphaBoard = await (await get(app, ctx, `/admin?demo=${alpha}`)).text();
    expect(alphaBoard).toContain("Visitor Alpha");
    expect(alphaBoard).not.toContain("Visitor Bravo");
    expect(alphaBoard).toContain(`demo=${alpha}`);
    expect(alphaBoard).toContain(`All<span class="tab-count">10</span>`);

    const bravoBoard = await (await get(app, ctx, `/admin?demo=${bravo}`)).text();
    expect(bravoBoard).toContain("Visitor Bravo");
    expect(bravoBoard).not.toContain("Visitor Alpha");

    const anonymous = await (await get(app, ctx, "/admin")).text();
    expect(anonymous).not.toContain("Visitor Alpha");
    expect(anonymous).not.toContain("Visitor Bravo");

    // Knowing another visitor's lead id is not enough to open it.
    const alphaLead = String(ctx.state.activity.find((row) => row.lead_name === "Visitor Alpha")!.lead_id);
    expect(alphaLead).toMatch(/^demo-/);
    expect((await get(app, ctx, `/admin/leads/${alphaLead}?demo=${bravo}`)).status).toBe(404);
    expect((await get(app, ctx, `/admin/leads/${alphaLead}`)).status).toBe(404);
    expect((await post(app, ctx, `/admin/leads/${alphaLead}/notes`, { body: "hi", demo: bravo })).status).toBe(404);
    expect((await post(app, ctx, `/admin/leads/${alphaLead}/delete`, { confirm: "yes", demo: bravo })).status).toBe(404);
    const own = await get(app, ctx, `/admin/leads/${alphaLead}?demo=${alpha}`);
    expect(own.status).toBe(200);
    const ownText = await own.text();
    expect(ownText).toContain("jordan.pike@example.com");
    expect(ownText).toContain("Hall bath needs a new tub surround and vanity.");
    // The lead's saved details stay out of its history.
    expect(ownText).not.toContain("{&quot;name&quot;");
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

  it("lets visitors delete leads they added, but not the sample leads", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();
    const sent = await post(app, ctx, "/estimate", { ...request, name: "Delete Me" });
    const key = demoKey(sent);
    const leadId = String(ctx.state.activity[0]!.lead_id);
    await post(app, ctx, `/admin/leads/${leadId}/notes`, { body: "Test note.", demo: key });

    const deleted = await post(app, ctx, `/admin/leads/${leadId}/delete`, { confirm: "yes", demo: key });
    expect(deleted.headers.get("location")).toBe(`/admin?saved=deleted&demo=${key}`);
    expect(ctx.state.activity).toHaveLength(0);
    expect(await (await get(app, ctx, `/admin?demo=${key}`)).text()).not.toContain("Delete Me");

    const sample = await post(app, ctx, "/admin/leads/sample-maya/delete", { confirm: "yes", demo: key });
    expect(sample.status).toBe(422);
    const text = await sample.text();
    expect(text).toContain("Sample leads stay in the demo");
    expect(text).toContain(`demo=${key}`);
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
    expect(ctx.state.activity).toHaveLength(DEMO_LIMITS.leads);

    // Notes count toward the visitor's entries too.
    for (let count = DEMO_LIMITS.leads; count < DEMO_LIMITS.entries; count += 1) {
      expect((await post(app, ctx, "/admin/leads/sample-maya/notes", { body: `Note ${count}`, demo: key })).status).toBe(303);
    }
    expect((await post(app, ctx, "/admin/leads/sample-maya/notes", { body: "One more", demo: key })).status).toBe(429);
    expect(ctx.state.activity).toHaveLength(DEMO_LIMITS.entries);
  });

  it("takes at most perHour entries an hour across everyone, even from visitors without a key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-01T12:00:00Z"));
    const app = createApp({ demo });
    const ctx = makeCtx();
    // Every keyless save gets a new key, so only the hourly limit stops a script.
    for (let index = 0; index < DEMO_LIMITS.perHour; index += 1) {
      expect((await post(app, ctx, "/estimate", request)).status).toBe(303);
    }
    const response = await post(app, ctx, "/estimate", request);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("The demo is busy");
    const note = await post(app, ctx, "/admin/leads/sample-maya/notes", { body: "One more" });
    expect(note.status).toBe(429);
    expect(ctx.state.activity).toHaveLength(DEMO_LIMITS.perHour);

    // Looking around still works.
    expect((await get(app, ctx, "/admin")).status).toBe(200);

    // An hour later it takes entries again.
    vi.setSystemTime(Date.parse("2026-09-01T13:01:00Z"));
    expect((await post(app, ctx, "/estimate", request)).status).toBe(303);
  });

  it("lets a burst of simultaneous saves pass the hourly limit by no more than the burst", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();
    await seedEntries(ctx, DEMO_LIMITS.perHour - 1);
    const burst = await Promise.all(Array.from({ length: 5 }, () => post(app, ctx, "/estimate", request)));
    expect(burst.every((response) => response.status === 303 || response.status === 429)).toBe(true);
    expect(ctx.state.activity.length).toBeLessThanOrEqual(DEMO_LIMITS.perHour - 1 + 5);
    expect((await post(app, ctx, "/estimate", request)).status).toBe(429);
  });

  it("removes expired entries, and rows from older versions of the demo, a few per save", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();
    const expired = new Date(Date.now() - (DEMO_KEEP_HOURS + 1) * HOUR).toISOString();
    await seedEntries(ctx, 3, { savedAt: expired });
    // An older demo saved a lead row plus a "received" row without demo_saved_at.
    const oldLead = await ctx.data.collection("leads").create({ name: "Old Visitor", email: "old@example.com", stage: "new" });
    await ctx.data.collection("activity").create({ lead_id: oldLead.id, lead_name: "Old Visitor", kind: "received", stage: "new", body: "", demo_visitor: "oldvisitor00000000000000" });
    await seedEntries(ctx, 2, { legacy: true });
    const fresh = await post(app, ctx, "/estimate", request);
    expect(fresh.status).toBe(303);
    // Six old rows: one save removes SWEEP_BATCH of them (the legacy ones first).
    expect(ctx.state.activity).toHaveLength(6 - SWEEP_BATCH + 1);
    expect(ctx.state.leads).toHaveLength(0);

    await post(app, ctx, "/estimate", { ...request, demo: demoKey(fresh) });
    expect(ctx.state.activity.every((row) => row.demo_saved_at && Date.parse(String(row.demo_saved_at)) > Date.now() - HOUR)).toBe(true);
    expect(ctx.state.activity).toHaveLength(2);

    // Expired entries stop showing even before they're removed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (DEMO_KEEP_HOURS + 1) * HOUR);
    const board = await (await get(app, ctx, `/admin?demo=${demoKey(fresh)}`)).text();
    expect(board).not.toContain("Jordan Pike");
    expect(board).toContain(`All<span class="tab-count">9</span>`);
  });

  it("keeps a full demo within the Free plan's 1,000 data rows", () => {
    expect(DEMO_LIMITS.perHour * DEMO_KEEP_HOURS + SWEEP_BATCH).toBeLessThan(1000);
  });

  it("shows a friendly page when the app is out of data rows", async () => {
    const app = createApp({ demo });
    const ctx = makeCtx();
    ctx.faults.quotaFull = true;
    const response = await post(app, ctx, "/estimate", request);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("The demo is full for now");
  });
});

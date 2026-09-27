// @ts-expect-error Example server files are plain JavaScript app bundles.
import { createApp } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { DEMO_LIMITS, demo } from "../server/demo.js";

type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string };
type User = { id: string; email: string; roles: string[] } | null;

const ORIGIN = "https://crm.example.test";

/** In-memory stand-in for the Userland runtime ctx: data, auth, and log. */
function makeCtx({ user = null as User } = {}) {
  const state: Record<string, Row[]> = { leads: [], activity: [] };
  let clock = Date.parse("2026-09-01T12:00:00.000Z");
  const tick = () => new Date((clock += 1000)).toISOString();

  const collection = (name: string) => {
    const rows = state[name];
    if (!rows) throw new Error(`Unknown collection ${name}`);
    return {
      async create(input: Record<string, unknown>) {
        const now = tick();
        const row = { ...input, id: `${name}_${rows.length + 1}`, created_at: now, updated_at: now } as Row;
        rows.push(row);
        return { ...row };
      },
      async get(id: string) {
        const row = rows.find((candidate) => candidate.id === id);
        return row ? { ...row } : null;
      },
      async update(id: string, patch: Record<string, unknown>) {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row) throw new Error(`Missing row ${id}`);
        Object.assign(row, patch, { updated_at: tick() });
        return { ...row };
      },
      async list(options: { where?: Record<string, unknown>; limit?: number; cursor?: string } = {}) {
        const matches = rows
          .filter((row) => Object.entries(options.where ?? {}).every(([key, value]) => row[key] === value))
          .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
        const offset = options.cursor ? Number(atob(options.cursor)) : 0;
        const limit = options.limit ?? 50;
        const page = matches.slice(offset, offset + limit);
        return { rows: page.map((row) => ({ ...row })), ...(offset + limit < matches.length ? { cursor: btoa(String(offset + limit)) } : {}) };
      }
    };
  };

  const data = { collection, async transaction<T>(callback: (tx: { collection: typeof collection }) => Promise<T>) { return await callback({ collection }); } };
  return {
    state,
    data,
    auth: { currentUser: vi.fn(async () => user) },
    log: { info: vi.fn(async () => {}), error: vi.fn(async () => {}) }
  };
}

type Ctx = ReturnType<typeof makeCtx>;

function get(app: any, ctx: Ctx, path: string) {
  return app.fetch(new Request(`${ORIGIN}${path}`), ctx) as Promise<Response>;
}

function post(app: any, ctx: Ctx, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
      body: new URLSearchParams(fields).toString()
    }),
    ctx
  ) as Promise<Response>;
}

const request = {
  name: "Jordan Pike",
  email: "jordan.pike@example.com",
  phone: "(555) 010-9911",
  project: "bathroom",
  budget: "15k_40k",
  timeline: "1_3_months",
  details: "Hall bath needs a new tub surround and vanity."
};

function demoKey(response: Response) {
  const location = response.headers.get("location") ?? "";
  return new URL(location, ORIGIN).searchParams.get("demo") ?? "";
}

describe("public estimate form", () => {
  it("renders the form without demo notices when demo mode is off", async () => {
    const app = createApp();
    const response = await get(app, makeCtx(), "/");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('action="/estimate"');
    expect(body).toContain('name="website"');
    expect(body).not.toContain('name="robots"');
    expect(body).not.toContain("Demo app");
    expect(body).toContain("We only use your details to reply about this project.");
  });

  it("saves a valid request as a new lead with a history entry", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const response = await post(app, ctx, "/estimate", request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/thanks");
    expect(ctx.state.leads).toHaveLength(1);
    expect(ctx.state.leads[0]).toMatchObject({ name: "Jordan Pike", email: "jordan.pike@example.com", stage: "new", source: "website" });
    expect(ctx.state.activity[0]).toMatchObject({ lead_id: ctx.state.leads[0].id, kind: "received" });
    // App events never carry the visitor's contact details.
    expect(JSON.stringify(ctx.log.info.mock.calls)).not.toContain("jordan");
  });

  it("shows field errors and escapes what the visitor typed", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const response = await post(app, ctx, "/estimate", { ...request, name: '<script>alert("x")</script>', email: "not-an-email", project: "castle" });
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(body).toContain("Enter an email address like name@example.com.");
    expect(body).toContain("Choose the kind of project.");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>alert");
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("drops submissions that fill the hidden honeypot field", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const response = await post(app, ctx, "/estimate", { ...request, website: "http://spam.example" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/thanks");
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("rejects form posts from other sites and oversized fields", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const crossSite = await post(app, ctx, "/estimate", request, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    const tooLong = await post(app, ctx, "/estimate", { ...request, details: "x".repeat(1200) });
    expect(tooLong.status).toBe(422);
    expect(ctx.state.leads).toHaveLength(0);
  });
});

describe("owner routes with demo mode off", () => {
  it("send signed-out visitors to the sign-in page and save nothing", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const board = await get(app, ctx, "/admin?stage=new");
    expect(board.status).toBe(303);
    expect(board.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin%3Fstage%3Dnew");

    const detail = await get(app, ctx, "/admin/leads/leads_1");
    expect(detail.status).toBe(303);

    const create = await post(app, ctx, "/admin/leads", { ...request, source: "phone" });
    expect(create.status).toBe(401);
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("refuse signed-in app users without the owner role", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: { id: "u_2", email: "helper@example.com", roles: [] } });
    const response = await get(app, ctx, "/admin");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Owner access only");
  });

  it("let the owner add a lead, move it through stages, and add notes", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: { id: "u_1", email: "owner@example.com", roles: ["owner"] } });

    const created = await post(app, ctx, "/admin/leads", { ...request, source: "referral", timeline: "" });
    expect(created.status).toBe(303);
    const leadId = ctx.state.leads[0].id;
    expect(created.headers.get("location")).toBe(`/admin/leads/${leadId}?saved=created`);
    expect(ctx.state.activity[0]).toMatchObject({ kind: "added" });

    const updated = await post(app, ctx, `/admin/leads/${leadId}/stage`, { stage: "site_visit", follow_up_on: "2026-10-02" });
    expect(updated.status).toBe(303);
    expect(ctx.state.leads[0]).toMatchObject({ stage: "site_visit", follow_up_on: "2026-10-02" });

    const badDate = await post(app, ctx, `/admin/leads/${leadId}/stage`, { stage: "quoted", follow_up_on: "2026-02-31" });
    expect(badDate.status).toBe(422);
    expect(ctx.state.leads[0].stage).toBe("site_visit");

    const note = await post(app, ctx, `/admin/leads/${leadId}/notes`, { body: "Measured <b>8x10</b>. Needs a vent fan." });
    expect(note.status).toBe(303);
    expect(ctx.state.activity.map((entry) => entry.kind)).toEqual(["added", "stage", "follow_up", "note"]);

    const detail = await (await get(app, ctx, `/admin/leads/${leadId}`)).text();
    expect(detail).toContain("Measured &lt;b&gt;8x10&lt;/b&gt;");
    expect(detail).toContain('name="robots" content="noindex,nofollow"');
    expect(detail).toContain('href="/_userland/auth/logout"');

    const board = await (await get(app, ctx, "/admin?stage=site_visit")).text();
    expect(board).toMatch(/class="lead-link"[^>]*>Jordan Pike</);
    const quoted = await (await get(app, ctx, "/admin?stage=quoted")).text();
    expect(quoted).not.toContain('class="lead-link"');
    expect(quoted).toContain("No quoted leads right now.");
  });
});

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

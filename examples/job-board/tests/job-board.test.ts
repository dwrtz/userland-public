// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { createApp } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { demoMode } from "../server/demo.js";

type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string };

const DEMO_ORIGIN = "https://job-board-demo.apps.userland.fun";
const APP_ORIGIN = "https://loamwork.example.test";

const USERS: Record<string, { id: string; app_user_id: string; email: string; roles: string[] }> = {
  owner: { id: "appusr_owner", app_user_id: "appusr_owner", email: "owner@example.com", roles: ["owner"] },
  helper: { id: "appusr_helper", app_user_id: "appusr_helper", email: "helper@example.com", roles: [] }
};

function makeCtx() {
  const state: Record<string, Row[]> = { listings: [], "demo-listings": [] };
  let counter = 0;
  const data = {
    collection(name: string) {
      const rows = state[name];
      if (!rows) throw new Error(`Unknown collection ${name}`);
      return {
        async create(input: Record<string, unknown>) {
          counter += 1;
          const now = new Date(Date.now() + counter).toISOString();
          const row = { ...input, id: `row_${counter}`, created_at: now, updated_at: now } as Row;
          rows.push(row);
          return row;
        },
        async get(id: string) {
          return rows.find((row) => row.id === id) ?? null;
        },
        async update(id: string, patch: Record<string, unknown>) {
          const index = rows.findIndex((row) => row.id === id);
          if (index === -1) throw new Error(`Missing row ${id}`);
          rows[index] = { ...rows[index], ...patch };
          return rows[index];
        },
        async delete(id: string) {
          const index = rows.findIndex((row) => row.id === id);
          if (index !== -1) rows.splice(index, 1);
        },
        async list(options: { where?: Record<string, unknown>; order_by?: Array<{ field: string; direction?: string }>; limit?: number } = {}) {
          const where = options.where ?? {};
          const filtered = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
          for (const order of [...(options.order_by ?? [])].reverse()) {
            filtered.sort((a, b) => String(a[order.field]).localeCompare(String(b[order.field])) * (order.direction === "desc" ? -1 : 1));
          }
          return { rows: filtered.slice(0, options.limit ?? 50) };
        }
      };
    }
  };
  return {
    state,
    data,
    auth: {
      async currentUser(request: Request) {
        const match = /__Host-ul_session=([a-z]+)/u.exec(request.headers.get("cookie") ?? "");
        return match ? (USERS[match[1]] ?? null) : null;
      }
    },
    log: { info: vi.fn(async () => undefined), error: vi.fn(async () => undefined) }
  };
}

type Ctx = ReturnType<typeof makeCtx>;
type Server = { fetch(request: Request, ctx: Ctx): Promise<Response> };

const production: Server = createApp();

const validListing = {
  title: "Cheese cave assistant",
  employer: "Fog Hollow Creamery",
  location: "Astoria, OR",
  category: "livestock",
  job_type: "part-time",
  pay: "$20/hr",
  summary: "Turn and brush wheels of cheese in our aging cave, two days a week.",
  description: "We make four raw-milk cheeses and age them in a cave dug into the hillside. You'll flip, brush, and record every wheel.",
  apply_link: "fog@example.com",
  contact_name: "Ivy Lane",
  contact_email: "ivy.lane@example.com"
};

function get(server: Server, ctx: Ctx, url: string, session?: string) {
  return server.fetch(new Request(url, { headers: session ? { cookie: `__Host-ul_session=${session}` } : {} }), ctx);
}

function post(server: Server, ctx: Ctx, url: string, fields: Record<string, string>, session?: string, origin?: string) {
  return server.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(session ? { cookie: `__Host-ul_session=${session}` } : {}),
        ...(origin ? { origin } : {})
      },
      body: new URLSearchParams(fields).toString()
    }),
    ctx
  );
}

async function seedApproved(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  const row = await ctx.data.collection("listings").create({
    ...validListing,
    status: "approved",
    featured: false,
    owner_note: "Called them on Monday",
    history: [],
    submitted_at: "2026-09-01T10:00:00.000Z",
    published_at: "2026-09-02T10:00:00.000Z",
    ...overrides
  });
  return row;
}

describe("public board (production)", () => {
  it("lists approved jobs only and never shows contact details or notes", async () => {
    const ctx = makeCtx();
    await seedApproved(ctx);
    await seedApproved(ctx, { title: "Hidden pending job", status: "pending" });

    const response = await get(production, ctx, `${APP_ORIGIN}/`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Cheese cave assistant");
    expect(body).not.toContain("Hidden pending job");
    expect(body).not.toContain("ivy.lane@example.com");
    expect(body).not.toContain("Called them on Monday");
    expect(body).not.toContain('name="robots"');
  });

  it("filters by category and search words", async () => {
    const ctx = makeCtx();
    await seedApproved(ctx);
    await seedApproved(ctx, {
      title: "Orchard crew lead",
      employer: "Heron Hill Orchard",
      location: "Hood River, OR",
      summary: "Lead a pruning and harvest crew on 40 acres of pears.",
      category: "orchards",
      job_type: "full-time"
    });

    const byCategory = await (await get(production, ctx, `${APP_ORIGIN}/?category=orchards`)).text();
    expect(byCategory).toContain("Orchard crew lead");
    expect(byCategory).not.toContain("Cheese cave assistant");

    const bySearch = await (await get(production, ctx, `${APP_ORIGIN}/?q=cheese%20astoria`)).text();
    expect(bySearch).toContain("Cheese cave assistant");
    expect(bySearch).not.toContain("Orchard crew lead");
  });

  it("shows a job page for approved jobs and 404 for anything else", async () => {
    const ctx = makeCtx();
    const live = await seedApproved(ctx);
    const pending = await seedApproved(ctx, { status: "pending" });

    const page = await get(production, ctx, `${APP_ORIGIN}/jobs/${live.id}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('href="mailto:fog@example.com"');
    expect(html).toContain('"@type":"JobPosting"');
    expect(html).not.toContain("ivy.lane@example.com");

    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/${pending.id}`)).status).toBe(404);
    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/nope`)).status).toBe(404);
  });

  it("gives filtered and searched boards a readable tab title", async () => {
    const ctx = makeCtx();
    await seedApproved(ctx);
    const titleOf = async (query: string) => /<title>([^<]*)<\/title>/u.exec(await (await get(production, ctx, `${APP_ORIGIN}/${query}`)).text())?.[1];

    expect(await titleOf("?category=orchards&q=pear")).toBe("Jobs matching “pear” · Orchards &amp; vineyards · Loamwork");
    expect(await titleOf("?type=seasonal")).toBe("Seasonal jobs · Loamwork");
    expect(await titleOf("?q=%3Cb%3E")).toBe("Jobs matching “&lt;b&gt;” · Loamwork");
  });

  it("retries a page load once if reading data fails, but never repeats a form post", async () => {
    const ctx = makeCtx();
    const live = await seedApproved(ctx);
    const listings = ctx.data.collection("listings");
    let failures = 1;
    const flaky = {
      ...listings,
      async get(id: string) {
        if (failures-- > 0) throw new Error("data service unavailable");
        return listings.get(id);
      },
      async create(input: Record<string, unknown>) {
        if (failures-- > 0) throw new Error("data service unavailable");
        return listings.create(input);
      }
    };
    const flakyCtx = { ...ctx, data: { collection: (name: string) => (name === "listings" ? flaky : ctx.data.collection(name)) } };

    const page = await get(production, flakyCtx as Ctx, `${APP_ORIGIN}/jobs/${live.id}`);
    expect(page.status).toBe(200);
    expect(ctx.log.error).not.toHaveBeenCalled();

    failures = 1;
    const before = ctx.state.listings.length;
    const posted = await post(production, flakyCtx as Ctx, `${APP_ORIGIN}/post`, validListing);
    expect(posted.status).toBe(500);
    expect(ctx.state.listings.length).toBe(before);
    expect(ctx.log.error).toHaveBeenCalledTimes(1);
  });
});

describe("posting a job", () => {
  it("saves a valid listing as waiting for review", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, validListing);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/post/thanks");
    expect(ctx.state.listings).toHaveLength(1);
    expect(ctx.state.listings[0]).toMatchObject({ title: "Cheese cave assistant", status: "pending", featured: false });
    expect(ctx.log.info).toHaveBeenCalledWith("listing submitted", expect.objectContaining({ listing_id: "row_1" }));

    const board = await (await get(production, ctx, `${APP_ORIGIN}/`)).text();
    expect(board).not.toContain("Cheese cave assistant");
  });

  it("re-shows the form with messages when fields are missing or invalid", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, contact_email: "not-an-email", apply_link: "javascript:alert(1)", category: "space" });
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(body).toContain("Please check 3 things");
    expect(body).toContain('aria-invalid="true"');
    expect(ctx.state.listings).toHaveLength(0);
  });

  it("enforces length limits", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, summary: "x".repeat(161) });
    expect(response.status).toBe(422);
    expect(ctx.state.listings).toHaveLength(0);
  });

  it("quietly drops submissions that fill in the hidden honeypot field", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, website: "https://spam.example.com" });
    expect(response.status).toBe(303);
    expect(ctx.state.listings).toHaveLength(0);
  });

  it("escapes HTML in everything a visitor typed", async () => {
    const ctx = makeCtx();
    await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, title: '<script>alert("x")</script> Farm hand' });
    const owner = await (await get(production, ctx, `${APP_ORIGIN}/owner`, "owner")).text();
    expect(owner).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Farm hand");
    expect(owner).not.toContain("<script>alert");
  });
});

describe("owner pages (production)", () => {
  it("sends signed-out visitors to the Userland sign-in page", async () => {
    const ctx = makeCtx();
    const response = await get(production, ctx, `${APP_ORIGIN}/owner?tab=pending`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fowner%3Ftab%3Dpending");
  });

  it("rejects signed-out and non-owner changes without touching data", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "pending" });

    const signedOut = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" });
    expect(signedOut.status).toBe(401);

    const helper = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" }, "helper");
    expect(helper.status).toBe(403);

    const edit = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}`, { ...validListing, title: "Hijacked" });
    expect(edit.status).toBe(401);

    expect(ctx.state.listings[0]).toMatchObject({ status: "pending", title: "Cheese cave assistant" });
    expect((await get(production, ctx, `${APP_ORIGIN}/owner`, "helper")).status).toBe(403);
  });

  it("refuses owner changes posted from another site, even with the owner signed in", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "pending" });
    const evil = "https://evil.apps.userland.fun";

    const approve = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" }, "owner", evil);
    expect(approve.status).toBe(403);
    const edit = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}`, { ...validListing, title: "Hijacked" }, "owner", evil);
    expect(edit.status).toBe(403);
    const spam = await post(production, ctx, `${APP_ORIGIN}/post`, validListing, undefined, evil);
    expect(spam.status).toBe(403);
    expect(ctx.state.listings).toHaveLength(1);
    expect(ctx.state.listings[0]).toMatchObject({ status: "pending", title: "Cheese cave assistant" });

    // The same request from the board's own pages goes through.
    const sameSite = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" }, "owner", APP_ORIGIN);
    expect(sameSite.status).toBe(303);
    expect(ctx.state.listings[0]).toMatchObject({ status: "approved" });
  });

  it("lets the owner approve, edit, and close a listing", async () => {
    const ctx = makeCtx();
    await post(production, ctx, `${APP_ORIGIN}/post`, validListing);
    const id = ctx.state.listings[0].id;

    const queue = await get(production, ctx, `${APP_ORIGIN}/owner`, "owner");
    const queueHtml = await queue.text();
    expect(queue.status).toBe(200);
    expect(queueHtml).toContain("ivy.lane@example.com");
    expect(queueHtml).toContain("Waiting for review");

    const approve = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${id}/status`, { status: "approved" }, "owner");
    expect(approve.status).toBe(303);
    expect(ctx.state.listings[0]).toMatchObject({ status: "approved" });
    expect(ctx.state.listings[0].published_at).toBeTruthy();
    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/${id}`)).status).toBe(200);

    const edit = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${id}`, { ...validListing, title: "Cheese cave lead", featured: "on", owner_note: "Great fit" }, "owner");
    expect(edit.status).toBe(303);
    expect(ctx.state.listings[0]).toMatchObject({ title: "Cheese cave lead", featured: true, owner_note: "Great fit", status: "approved" });

    await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${id}/status`, { status: "closed" }, "owner");
    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/${id}`)).status).toBe(404);
    const history = (ctx.state.listings[0].history as Array<{ action: string }>).map((entry) => entry.action);
    expect(history).toEqual(["submitted", "approved", "edited", "closed"]);
  });

  it("keeps demo mode off on any host other than the demo host", async () => {
    const ctx = makeCtx();
    const response = await get(app, ctx, `${APP_ORIGIN}/owner`);
    expect(response.status).toBe(303);
    expect(ctx.state["demo-listings"]).toHaveLength(0);
  });
});

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

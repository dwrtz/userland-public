// Shared helpers for the job-board tests.
//
// makeCtx() builds on the shared runtime harness (scripts/runtime-harness.ts),
// which reads manifest.userland.json and enforces the platform's data rules:
// declared fields only, enum values, `where`/`order_by` fields must be indexed,
// `limit` between 1 and 100, and cursor paging. A query the real platform would
// refuse fails here too.
import path from "node:path";
import { createFakeRuntime, readExampleManifest, type FakeRow } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { createApp } from "../server/index.js";

export const DEMO_ORIGIN = "https://job-board-demo.apps.userland.fun";
export const APP_ORIGIN = "https://loamwork.example.test";
export const EXAMPLE_DIR = path.resolve(import.meta.dirname, "..");

export const USERS: Record<string, { id: string; app_user_id: string; email: string; roles: string[] }> = {
  owner: { id: "appusr_owner", app_user_id: "appusr_owner", email: "owner@example.com", roles: ["owner"] },
  helper: { id: "appusr_helper", app_user_id: "appusr_helper", email: "helper@example.com", roles: [] }
};

export function makeCtx() {
  const rt = createFakeRuntime(readExampleManifest(EXAMPLE_DIR));
  // ctx.state.listings (or ctx.state["demo-listings"]) is the live list of
  // stored rows, so tests can check what was saved.
  const state = new Proxy({} as Record<string, FakeRow[]>, {
    get: (_target, name) => rt.state.rows.get(String(name)) ?? []
  });
  return {
    ...rt.ctx,
    state,
    // The session cookie names which test user is signed in.
    auth: {
      ...rt.ctx.auth,
      async currentUser(request: Request) {
        const match = /__Host-ul_session=([a-z]+)/u.exec(request.headers.get("cookie") ?? "");
        return match ? (USERS[match[1]] ?? null) : null;
      }
    },
    log: {
      debug: vi.fn(rt.ctx.log.debug),
      info: vi.fn(rt.ctx.log.info),
      warn: vi.fn(rt.ctx.log.warn),
      error: vi.fn(rt.ctx.log.error)
    }
  };
}

export type Ctx = ReturnType<typeof makeCtx>;
export type Server = { fetch(request: Request, ctx: Ctx): Promise<Response> };

export const production: Server = createApp();

export const validListing = {
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

export function get(server: Server, ctx: Ctx, url: string, session?: string) {
  return server.fetch(new Request(url, { headers: session ? { cookie: `__Host-ul_session=${session}` } : {} }), ctx);
}

export function post(server: Server, ctx: Ctx, url: string, fields: Record<string, string>, session?: string, origin?: string) {
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

export async function seedApproved(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  return await ctx.data.collection("listings").create({
    ...validListing,
    status: "approved",
    featured: false,
    owner_note: "Called them on Monday",
    history: [],
    submitted_at: "2026-09-01T10:00:00.000Z",
    published_at: "2026-09-02T10:00:00.000Z",
    ...overrides
  });
}

/** Seed `count` listings, oldest first; listing i is dated i minutes after the base time. */
export async function seedMany(ctx: Ctx, count: number, make: (index: number) => Record<string, unknown>) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const at = new Date(Date.UTC(2026, 6, 1) + index * 60_000).toISOString();
    rows.push(await seedApproved(ctx, { submitted_at: at, published_at: at, ...make(index) }));
  }
  return rows;
}

/** Follow "Show more" links on an owner tab and return every page's HTML. */
export async function ownerPages(server: Server, ctx: Ctx, tab: string) {
  const pages: string[] = [];
  let url: string | null = `${APP_ORIGIN}/owner?tab=${tab}`;
  while (url && pages.length < 50) {
    const response = await get(server, ctx, url, "owner");
    expect(response.status).toBe(200);
    const body = await response.text();
    pages.push(body);
    const next = /<a [^>]*href="([^"]+)" rel="next">Show more<\/a>/u.exec(body)?.[1];
    url = next ? `${APP_ORIGIN}${next.replaceAll("&amp;", "&")}` : null;
  }
  return pages;
}

// Shared helpers for the link-in-bio-app tests.
import path from "node:path";
import { FakeRuntimeError, createFakeRuntime, readExampleManifest, type FakeRow } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

export const APP = "https://kiln.example.test";
export const DEMO = "https://link-in-bio-demo.apps.userland.fun";
export const OWNER_COOKIE = "__Host-ul_session=owner-session";
export const FAN_COOKIE = "__Host-ul_session=fan-session";
export const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export type Row = Record<string, any>;

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

// A Userland runtime ctx built by the shared harness from this example's
// manifest, so undeclared fields, unindexed queries, and unique indexes fail
// here the way they do on Userland. On top of it:
//
// - app-user auth keyed by the session cookie. Like the Userland runtime,
//   requireUser/requireRole throw errors with a code and a 401/403 status.
// - a unique index clash throws `unique_conflict`, the code Userland uses.
// - `maxRows` makes creates fail with `quota_exceeded` past that many rows,
//   like a plan's saved-item limit.
// - `state.links`, `state.tallies`, `state.inbox`, and `state.visitors` show
//   the stored rows (link rows, tap tallies, inbox items, demo visitor rows).
export function makeCtx({ maxRows }: { maxRows?: number } = {}) {
  const rt = createFakeRuntime(manifest);
  const users: Record<string, { id: string; app_user_id: string; email: string; roles: string[] }> = {
    "owner-session": { id: "u_owner", app_user_id: "u_owner", email: "wren@example.com", roles: ["owner"] },
    "fan-session": { id: "u_fan", app_user_id: "u_fan", email: "fan@example.com", roles: [] }
  };
  const sessionUser = (request: Request) => {
    const match = /__Host-ul_session=([^;]+)/.exec(request.headers.get("cookie") ?? "");
    return match ? (users[match[1]] ?? null) : null;
  };
  const allRows = () => [...rt.state.rows.values()].reduce((sum, rows) => sum + rows.length, 0);
  const rethrow = (error: any): never => {
    if (error?.code === "unique_violation") throw new FakeRuntimeError("unique_conflict", error.message, 409);
    throw error;
  };

  const data = {
    app_id: rt.ctx.data.app_id,
    collection(name: string) {
      const inner = rt.ctx.data.collection(name);
      return {
        ...inner,
        async create(input: Row) {
          if (maxRows !== undefined && allRows() >= maxRows) throw new FakeRuntimeError("quota_exceeded", "Data row limit reached.", 402);
          return await inner.create(input).catch(rethrow);
        },
        async update(id: string, patch: Row) {
          return await inner.update(id, patch).catch(rethrow);
        }
      };
    }
  };

  const project = (row: FakeRow): Row => ({ ...row.data, id: row.id, created_at: row.created_at, updated_at: row.updated_at });
  const rows = (name: string) => rt.state.rows.get(name)!.map(project);
  const isTally = (row: Row) => String(row.slot ?? "").includes("/taps/");

  return {
    data,
    auth: {
      async currentUser(request: Request) {
        return sessionUser(request);
      },
      async requireUser(request: Request) {
        const user = sessionUser(request);
        if (!user) throw new FakeRuntimeError("unauthorized", "Authentication required.", 401);
        return user;
      },
      async requireRole(request: Request, role: string) {
        const user = sessionUser(request);
        if (!user) throw new FakeRuntimeError("unauthorized", "Authentication required.", 401);
        if (!user.roles.includes(role)) throw new FakeRuntimeError("forbidden", "Required role is missing.", 403);
        return user;
      }
    },
    log: { info: vi.fn(async () => {}), error: vi.fn(async () => {}) },
    state: {
      get links() {
        return rows("links").filter((row) => !isTally(row));
      },
      get tallies() {
        return rows("links").filter(isTally);
      },
      get inbox() {
        return rows("inbox").filter((row) => row.kind);
      },
      get visitors() {
        return rows("inbox").filter((row) => !row.kind);
      },
      get total() {
        return allRows();
      }
    }
  };
}

export type Ctx = ReturnType<typeof makeCtx>;

// The UTC hour `offset` hours from now as YYYYMMDDHH, the prefix of a demo key.
export function hourStamp(offset: number) {
  return new Date(Date.now() + offset * 3_600_000).toISOString().slice(0, 13).replace(/[-T]/g, "");
}

export type Server = { fetch(request: Request, ctx: any): Promise<Response> };

// Headers a browser sends. Pass a header as null to leave it out.
function browserHeaders(url: string, headers: Record<string, string | null>, method: string) {
  const out = new Headers({ "user-agent": BROWSER, ...(method === "POST" ? { origin: new URL(url).origin } : {}) });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) out.delete(name);
    else out.set(name, value);
  }
  return out;
}

export function get(ctx: Ctx, url: string, headers: Record<string, string | null> = {}, server: Server = app) {
  return server.fetch(new Request(url, { headers: browserHeaders(url, headers, "GET") }), ctx) as Promise<Response>;
}

// Posts a form the way a browser does from the app's own page: with the
// app's Origin. Pass { origin: null } or another origin to test the checks.
export function post(ctx: Ctx, url: string, fields: Record<string, string>, headers: Record<string, string | null> = {}, server: Server = app) {
  return server.fetch(
    new Request(url, {
      method: "POST",
      headers: browserHeaders(url, { "content-type": "application/x-www-form-urlencoded", ...headers }, "POST"),
      body: new URLSearchParams(fields).toString()
    }),
    ctx
  ) as Promise<Response>;
}

export async function addStarterLinks(ctx: Ctx) {
  const res = await post(ctx, `${APP}/admin/links/starter`, {}, { cookie: OWNER_COOKIE });
  expect(res.status).toBe(303);
}

// The visit key in a redirect's address.
export function keyFrom(res: Response) {
  return /visit=([^&]+)/.exec(res.headers.get("location") ?? "")?.[1] ?? null;
}

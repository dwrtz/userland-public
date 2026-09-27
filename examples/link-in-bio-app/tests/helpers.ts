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

type IndexSpec = { name: string; fields: string[]; unique?: boolean };
const collectionSpecs = (manifest as any).resources.data.collections as Record<string, { indexes?: IndexSpec[] }>;
const uniqueIndexes = (name: string) => (collectionSpecs[name]?.indexes ?? []).filter((index) => index.unique);

// The shared harness checks unique indexes in one step. Userland doesn't, so
// unique indexes are handled here instead, in the same order as Userland's
// create: check the unique value, then (after a few other steps) save the row,
// then record the unique value. Two creates with the same value that arrive
// together can both pass the check; the later one then fails with a plain
// database error (no `unique_conflict` code) and its row stays saved.
const plainManifest = structuredClone(manifest) as any;
for (const spec of Object.values(plainManifest.resources.data.collections) as Array<{ indexes?: IndexSpec[] }>) {
  spec.indexes = (spec.indexes ?? []).map(({ unique, ...index }) => index);
}

// Lets other requests run, like a network round trip on Userland.
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A Userland runtime ctx built by the shared harness from this example's
// manifest, so undeclared fields and unindexed queries fail here the way they
// do on Userland. On top of it:
//
// - app-user auth keyed by the session cookie. Like the Userland runtime,
//   requireUser/requireRole throw errors with a code and a 401/403 status.
// - unique indexes work like Userland's (see above): a value that is already
//   taken throws `unique_conflict`; a clash between two creates that arrive
//   together can leave the losing row behind with a plain error.
// - every data call waits a moment, so requests started with Promise.all
//   interleave the way they can on Userland.
// - `maxRows` makes creates fail with `quota_exceeded` past that many rows,
//   like a plan's saved-item limit.
// - `state.links`, `state.tallies`, `state.inbox`, and `state.visitors` show
//   the stored rows (link rows, tap tallies, inbox items, demo visitor rows).
export function makeCtx({ maxRows }: { maxRows?: number } = {}) {
  const rt = createFakeRuntime(plainManifest);
  // Unique values recorded so far: "<collection> <index> <values>" -> row id.
  const taken = new Map<string, string>();
  const uniqueKeys = (name: string, row: Row) =>
    uniqueIndexes(name)
      .filter((index) => index.fields.every((field) => row[field] !== undefined && row[field] !== null))
      .map((index) => `${name} ${index.name} ${JSON.stringify(index.fields.map((field) => row[field]))}`);
  const conflict = (key: string) => new FakeRuntimeError("unique_conflict", `Unique index already contains this value (${key}).`, 409);
  const users: Record<string, { id: string; app_user_id: string; email: string; roles: string[] }> = {
    "owner-session": { id: "u_owner", app_user_id: "u_owner", email: "wren@example.com", roles: ["owner"] },
    "fan-session": { id: "u_fan", app_user_id: "u_fan", email: "fan@example.com", roles: [] }
  };
  const sessionUser = (request: Request) => {
    const match = /__Host-ul_session=([^;]+)/.exec(request.headers.get("cookie") ?? "");
    return match ? (users[match[1]] ?? null) : null;
  };
  const allRows = () => [...rt.state.rows.values()].reduce((sum, rows) => sum + rows.length, 0);
  const data = {
    app_id: rt.ctx.data.app_id,
    collection(name: string) {
      const inner = rt.ctx.data.collection(name);
      return {
        async create(input: Row) {
          await tick();
          const keys = uniqueKeys(name, input);
          for (const key of keys) if (taken.has(key)) throw conflict(key);
          await tick(); // plan usage checks
          if (maxRows !== undefined && allRows() >= maxRows) throw new FakeRuntimeError("quota_exceeded", "Data row limit reached.", 402);
          const row = await inner.create(input);
          await tick();
          for (const key of keys) {
            if (taken.has(key)) throw new Error("D1_ERROR: UNIQUE constraint failed: app_data_unique_indexes.app_id, app_data_unique_indexes.collection_name, app_data_unique_indexes.index_name, app_data_unique_indexes.index_value: SQLITE_CONSTRAINT");
            taken.set(key, row.id);
          }
          return row;
        },
        async get(id: string) {
          await tick();
          return await inner.get(id);
        },
        async update(id: string, patch: Row) {
          await tick();
          const current = await inner.get(id);
          const keys = current ? uniqueKeys(name, { ...current.data, ...patch }) : [];
          for (const key of keys) if (taken.has(key) && taken.get(key) !== id) throw conflict(key);
          const row = await inner.update(id, patch);
          for (const [key, owner] of taken) if (owner === id) taken.delete(key);
          for (const key of keys) taken.set(key, id);
          return row;
        },
        async delete(id: string) {
          await tick();
          await inner.delete(id);
          for (const [key, owner] of taken) if (owner === id) taken.delete(key);
        },
        async list(input?: Parameters<typeof inner.list>[0]) {
          await tick();
          return await inner.list(input);
        },
        async query(input?: Parameters<typeof inner.list>[0]) {
          await tick();
          return await inner.query(input);
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

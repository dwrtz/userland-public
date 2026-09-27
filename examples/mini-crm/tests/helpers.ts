// Shared helpers for the mini-crm tests.

import path from "node:path";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";

export type User = { id: string; email: string; roles: string[] } | null;

export const ORIGIN = "https://crm.example.test";
/** The public demo's address, where demo mode turns on (DEMO_HOSTS in server/demo.js). */
export const DEMO_ORIGIN = "https://mini-crm-demo.apps.userland.fun";

export const EXAMPLE_DIR = path.resolve(import.meta.dirname, "..");

/**
 * A test ctx built from this example's manifest by the shared runtime harness,
 * so queries on fields without an index fail here as they do on Userland.
 * Differences from the plain harness, to match deployed apps:
 * - a unique index clash throws code "unique_conflict";
 * - ctx.data.transaction does not undo earlier writes when a later one throws;
 * - `faults.quotaFull` makes every create throw code "quota_exceeded", like an
 *   app that has used its plan's data rows.
 */
export function makeCtx({ user = null as User, manifest = readExampleManifest(EXAMPLE_DIR) } = {}) {
  const rt = createFakeRuntime(manifest, { user: user ? { ...user, app_user_id: user.id } : null });
  const faults = { quotaFull: false };

  const rethrow = (error: any): never => {
    if (error?.code === "unique_violation") throw Object.assign(new Error(error.message), { code: "unique_conflict", status: 409 });
    throw error;
  };

  const collection = (name: string) => {
    const inner = rt.ctx.data.collection(name);
    return {
      async create(input: Record<string, unknown>) {
        if (faults.quotaFull) throw Object.assign(new Error("Data row quota exceeded."), { code: "quota_exceeded", status: 402 });
        return await inner.create(input).catch(rethrow);
      },
      get: inner.get,
      update: (id: string, patch: Record<string, unknown>) => inner.update(id, patch).catch(rethrow),
      delete: inner.delete,
      list: inner.list,
      query: inner.query
    };
  };

  const data = {
    app_id: "app_test",
    collection,
    async transaction<T>(callback: (tx: { collection: typeof collection }) => Promise<T>) {
      return await callback({ collection });
    }
  };

  return {
    rt,
    faults,
    data,
    /** The rows saved so far, by collection. */
    get state() {
      return { leads: rt.state.rows.get("leads")!, activity: rt.state.rows.get("activity")! };
    },
    setUser(next: User) {
      rt.setUser(next ? { ...next, app_user_id: next.id } : null);
    },
    auth: { currentUser: vi.fn(async (request: Request) => await rt.ctx.auth.currentUser(request)) },
    log: { info: vi.fn(async () => {}), warn: vi.fn(async () => {}), error: vi.fn(async () => {}) }
  };
}

export type Ctx = ReturnType<typeof makeCtx>;

export const OWNER = { id: "u_1", email: "owner@example.com", roles: ["owner"] };

/** Request helpers for one origin. */
export function at(origin: string) {
  return {
    get(app: any, ctx: Ctx, path: string) {
      return app.fetch(new Request(`${origin}${path}`), ctx) as Promise<Response>;
    },
    post(app: any, ctx: Ctx, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
      return app.fetch(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin, ...headers },
          body: new URLSearchParams(fields).toString()
        }),
        ctx
      ) as Promise<Response>;
    }
  };
}

export const { get, post } = at(ORIGIN);

export const request = {
  name: "Jordan Pike",
  email: "jordan.pike@example.com",
  phone: "(555) 010-9911",
  project: "bathroom",
  budget: "15k_40k",
  timeline: "1_3_months",
  details: "Hall bath needs a new tub surround and vanity."
};

export function demoKey(response: Response) {
  const location = response.headers.get("location") ?? "";
  return new URL(location, ORIGIN).searchParams.get("demo") ?? "";
}

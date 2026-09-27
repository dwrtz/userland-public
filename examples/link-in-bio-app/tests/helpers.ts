// Shared helpers for the link-in-bio-app tests.
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

export const APP = "https://kiln.example.test";
export const DEMO = "https://link-in-bio-demo.apps.userland.fun";
export const OWNER_COOKIE = "__Host-ul_session=owner-session";
export const FAN_COOKIE = "__Host-ul_session=fan-session";

export type Row = Record<string, any>;

// An in-memory stand-in for the Userland runtime ctx: data collections with
// exact-match `where`, plus app-user auth keyed by the session cookie.
export function makeCtx() {
  const state: Record<string, Row[]> = { links: [], inbox: [] };
  let seq = 0;
  const users: Record<string, { id: string; email: string; roles: string[] }> = {
    "owner-session": { id: "u_owner", email: "wren@example.com", roles: ["owner"] },
    "fan-session": { id: "u_fan", email: "fan@example.com", roles: [] }
  };
  const sessionUser = (request: Request) => {
    const match = /__Host-ul_session=([^;]+)/.exec(request.headers.get("cookie") ?? "");
    return match ? (users[match[1]] ?? null) : null;
  };

  const data = {
    collection(name: string) {
      const rows = state[name];
      if (!rows) throw new Error(`Unknown collection ${name}`);
      return {
        async create(input: Row) {
          const now = new Date().toISOString();
          const row = { ...input, id: `${name}_${++seq}`, created_at: now, updated_at: now };
          rows.push(row);
          return { ...row };
        },
        async get(id: string) {
          const row = rows.find((r) => r.id === id);
          return row ? { ...row } : null;
        },
        async update(id: string, patch: Row) {
          const index = rows.findIndex((r) => r.id === id);
          if (index === -1) throw new Error(`Missing row ${id}`);
          rows[index] = { ...rows[index], ...patch };
          return { ...rows[index] };
        },
        async delete(id: string) {
          const index = rows.findIndex((r) => r.id === id);
          if (index !== -1) rows.splice(index, 1);
        },
        async list(query: { where?: Row; order_by?: Array<{ field: string; direction?: string }>; limit?: number } = {}) {
          let out = rows.filter((r) => Object.entries(query.where ?? {}).every(([k, v]) => r[k] === v));
          for (const order of query.order_by ?? []) {
            out = [...out].sort((a, b) => String(a[order.field]).localeCompare(String(b[order.field])) * (order.direction === "desc" ? -1 : 1));
          }
          return { rows: out.slice(0, query.limit ?? 50).map((r) => ({ ...r })) };
        }
      };
    }
  };

  return {
    state,
    data,
    auth: {
      async currentUser(request: Request) {
        return sessionUser(request);
      },
      async requireRole(request: Request, role: string) {
        const user = sessionUser(request);
        // Like the Userland runtime: plain errors, no status.
        if (!user) throw new Error("Authentication required.");
        if (!user.roles.includes(role)) throw new Error("Required role is missing.");
        return user;
      }
    },
    log: { info: vi.fn(async () => {}), error: vi.fn(async () => {}) }
  };
}

export type Ctx = ReturnType<typeof makeCtx>;

// The UTC hour `offset` hours from now as YYYYMMDDHH, the prefix of a demo key.
export function hourStamp(offset: number) {
  return new Date(Date.now() + offset * 3_600_000).toISOString().slice(0, 13).replace(/[-T]/g, "");
}

export type Server = { fetch(request: Request, ctx: any): Promise<Response> };

export function get(ctx: Ctx, url: string, headers: Record<string, string> = {}, server: Server = app) {
  return server.fetch(new Request(url, { headers }), ctx) as Promise<Response>;
}

export function post(ctx: Ctx, url: string, fields: Record<string, string>, headers: Record<string, string> = {}, server: Server = app) {
  return server.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString()
    }),
    ctx
  ) as Promise<Response>;
}

export async function addStarterLinks(ctx: Ctx) {
  const res = await post(ctx, `${APP}/admin/links/starter`, {}, { cookie: OWNER_COOKIE });
  expect(res.status).toBe(303);
}

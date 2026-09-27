// Shared helpers for the job-board tests.
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { createApp } from "../server/index.js";

export type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string };

export const DEMO_ORIGIN = "https://job-board-demo.apps.userland.fun";
export const APP_ORIGIN = "https://loamwork.example.test";

export const USERS: Record<string, { id: string; app_user_id: string; email: string; roles: string[] }> = {
  owner: { id: "appusr_owner", app_user_id: "appusr_owner", email: "owner@example.com", roles: ["owner"] },
  helper: { id: "appusr_helper", app_user_id: "appusr_helper", email: "helper@example.com", roles: [] }
};

export function makeCtx() {
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

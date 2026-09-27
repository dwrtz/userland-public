// Shared helpers for the mini-crm tests.

export type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string };
export type User = { id: string; email: string; roles: string[] } | null;

export const ORIGIN = "https://crm.example.test";
/** The public demo's address, where demo mode turns on (DEMO_HOSTS in server/demo.js). */
export const DEMO_ORIGIN = "https://mini-crm-demo.apps.userland.fun";

/** In-memory stand-in for the Userland runtime ctx: data, auth, and log. */
export function makeCtx({ user = null as User } = {}) {
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

export type Ctx = ReturnType<typeof makeCtx>;

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

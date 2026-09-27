// Shared helpers for the waitlist-app tests.
import { readFileSync } from "node:fs";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

export type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string };
export type CollectionSpec = { fields: Record<string, unknown>; indexes?: Array<{ name: string; fields: string[]; unique?: boolean }> };

export const manifest = JSON.parse(readFileSync(new URL("../manifest.userland.json", import.meta.url), "utf8"));
export const collections: Record<string, CollectionSpec> = manifest.resources.data.collections;

export const APP = "https://velto.example.test";
export const DEMO = "https://waitlist-demo.apps.userland.fun";

// An in-memory ctx that follows the runtime rules: declared fields only, `where` and
// `order_by` on indexed fields only, unique indexes, and at most 100 rows per list call.
// `rowLimit` plays the plan's row limit: a create past it throws `quota_exceeded` (402).
export function makeCtx(specs: Record<string, CollectionSpec> = collections, { rowLimit = Infinity }: { rowLimit?: number } = {}) {
  const tables: Record<string, Row[]> = {};
  let next = 0;
  const failure = (code: string, message: string) => Object.assign(new Error(message), { code, status: 400 });

  function collection(name: string) {
    const spec = specs[name];
    if (!spec) throw failure("missing_collection", `Data collection ${name} is not declared.`);
    const rows = (tables[name] ??= []);
    const indexed = new Set((spec.indexes ?? []).flatMap((index) => index.fields));
    const checkFields = (input: Record<string, unknown>) => {
      for (const key of Object.keys(input)) if (!(key in spec.fields)) throw failure("invalid_resource_manifest", `Field ${key} is not declared.`);
    };
    const checkUnique = (data: Record<string, unknown>, id: string | null) => {
      for (const index of (spec.indexes ?? []).filter((item) => item.unique)) {
        const value = JSON.stringify(index.fields.map((field) => data[field]));
        if (rows.some((row) => row.id !== id && JSON.stringify(index.fields.map((field) => row[field])) === value)) {
          throw failure("unique_conflict", `Unique index ${index.name} already contains this value.`);
        }
      }
    };
    return {
      async create(input: Record<string, unknown>) {
        checkFields(input);
        checkUnique(input, null);
        const used = Object.values(tables).reduce((sum, table) => sum + table.length, 0);
        if (used >= rowLimit) throw Object.assign(new Error("Data row limit reached."), { code: "quota_exceeded", status: 402, metric: "data.rows.max" });
        const now = new Date().toISOString();
        const row: Row = { ...input, id: `row_${++next}`, created_at: now, updated_at: now };
        rows.push(row);
        return { ...row };
      },
      async get(id: string) {
        const row = rows.find((item) => item.id === id);
        return row ? { ...row } : null;
      },
      async update(id: string, patch: Record<string, unknown>) {
        checkFields(patch);
        const index = rows.findIndex((item) => item.id === id);
        if (index === -1) throw failure("not_found", "Data row not found.");
        const updated = { ...rows[index], ...patch, updated_at: new Date().toISOString() } as Row;
        checkUnique(updated, id);
        rows[index] = updated;
        return { ...updated };
      },
      async delete(id: string) {
        const index = rows.findIndex((item) => item.id === id);
        if (index !== -1) rows.splice(index, 1);
      },
      async list(
        query: { where?: Record<string, unknown>; order_by?: Array<{ field: string; direction?: "asc" | "desc" }>; limit?: number; cursor?: string } = {}
      ) {
        for (const field of Object.keys(query.where ?? {})) if (!indexed.has(field)) throw failure("unindexed_query", `Query field ${field} is not indexed.`);
        for (const order of query.order_by ?? []) if (!indexed.has(order.field)) throw failure("unindexed_query", `Order field ${order.field} is not indexed.`);
        if (query.limit !== undefined && (query.limit < 1 || query.limit > 100)) throw failure("invalid_query", "Query limit must be between 1 and 100.");
        const matches = rows.filter((row) => Object.entries(query.where ?? {}).every(([key, value]) => row[key] === value));
        for (const order of [...(query.order_by ?? [])].reverse()) {
          const direction = order.direction === "desc" ? -1 : 1;
          matches.sort((a, b) => String(a[order.field] ?? "").localeCompare(String(b[order.field] ?? "")) * direction);
        }
        const offset = query.cursor ? Number(atob(query.cursor)) : 0;
        const page = matches.slice(offset, offset + (query.limit ?? 50));
        const end = offset + page.length;
        return { rows: page.map((row) => ({ ...row })), ...(end < matches.length ? { cursor: btoa(String(end)) } : {}) };
      }
    };
  }

  type Data = { collection: typeof collection; transaction<T>(callback: (tx: Data) => Promise<T>): Promise<T> };
  const data: Data = { collection, async transaction(callback) { return await callback(data); } };
  const users: Record<string, { id: string; email: string; roles: string[] }> = {
    owner: { id: "user_owner", email: "owner@example.com", roles: ["owner"] },
    helper: { id: "user_helper", email: "helper@example.com", roles: [] }
  };
  const currentUser = async (request: Request) => {
    const session = /__Host-ul_session=(\w+)/u.exec(request.headers.get("cookie") ?? "")?.[1];
    return session ? users[session] ?? null : null;
  };
  return {
    tables,
    data,
    auth: {
      currentUser,
      async requireRole(request: Request, role: string) {
        const user = await currentUser(request);
        if (!user || !user.roles.includes(role)) throw new Error("Required role is missing.");
        return user;
      }
    },
    log: { info: vi.fn(async () => undefined), warn: vi.fn(async () => undefined), error: vi.fn(async () => undefined) }
  };
}

export type Ctx = ReturnType<typeof makeCtx>;

export type Server = { fetch(request: Request, ctx: Ctx): Promise<Response> };

export async function call(ctx: Ctx, url: string, init: RequestInit = {}, server: Server = app): Promise<Response> {
  return await server.fetch(new Request(url, init), ctx);
}

export function post(ctx: Ctx, url: string, fields: Record<string, string>, headers: Record<string, string> = {}, server: Server = app) {
  return call(
    ctx,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin, ...headers },
      body: new URLSearchParams(fields).toString()
    },
    server
  );
}

export async function join(ctx: Ctx, base: string, fields: Record<string, string>, server: Server = app) {
  const response = await post(ctx, `${base}/join`, fields, {}, server);
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(/^\/you\/[^/]+\/[^/]+$/u);
  return location;
}

export const owner = { cookie: "__Host-ul_session=owner" };

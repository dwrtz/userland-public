// Test harness that builds a fake Userland runtime `ctx` from an example's
// manifest.userland.json. It follows the public runtime contract
// (https://docs.userland.fun/reference/runtime-ctx and
// https://docs.userland.fun/types/runtime-context-v0.d.ts) and enforces the
// v0 rules that most often break example code:
//
// - data rows may only use declared fields, with values matching field types;
// - list/query `where` and `order_by` fields must be declared and indexed;
// - list/query `limit` must be between 1 and 100;
// - unique indexes reject duplicates;
// - rows expose declared fields plus id, created_at, updated_at, and data;
// - files, secrets, and jobs must be declared in the manifest;
// - auth helpers require `auth.mode: "app_users"`.
//
// It is intentionally small. It does not model access rules, quotas, or
// transaction isolation beyond rolling back on a thrown error.

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

type Json = Record<string, unknown>;

export type FakeAppUser = { id: string; app_user_id: string; email: string; roles: string[] };

export type FakeRuntimeOptions = {
  secrets?: Record<string, string>;
  user?: FakeAppUser | null;
  now?: () => Date;
};

export type FakeRow = Json & { id: string; created_at: string; updated_at: string; data: Json };

export type LogEntry = { level: "debug" | "info" | "warn" | "error"; message: string; metadata?: Json };

export class FakeRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "FakeRuntimeError";
  }
}

type CollectionSpec = {
  fields?: Record<string, string | { type: string; values?: string[]; collection?: string }>;
  indexes?: Array<{ name: string; fields: string[]; unique?: boolean }>;
};

export function readExampleManifest(exampleDir: string): Json {
  return JSON.parse(readFileSync(path.join(exampleDir, "manifest.userland.json"), "utf8")) as Json;
}

export function createFakeRuntime(manifest: Json, options: FakeRuntimeOptions = {}) {
  const resources = (manifest.resources ?? {}) as Json;
  const collections = (((resources.data ?? {}) as Json).collections ?? {}) as Record<string, CollectionSpec>;
  const stores = (((resources.files ?? {}) as Json).stores ?? {}) as Record<string, { max_file_size_bytes?: number; allowed_content_types?: string[] }>;
  const requiredSecrets = new Set((((resources.secrets ?? {}) as Json).required ?? []) as string[]);
  const jobs = (resources.jobs ?? {}) as Record<string, { trigger?: string }>;
  const auth = (resources.auth ?? {}) as { mode?: string; roles?: string[] };
  const now = options.now ?? (() => new Date());

  const state = {
    rows: new Map<string, FakeRow[]>(Object.keys(collections).map((name) => [name, []])),
    files: [] as Json[],
    enqueued: [] as Array<{ name: string; payload: Json }>,
    logs: [] as LogEntry[],
    user: options.user ?? null
  };
  let sequence = 0;
  let clock = 0;

  function timestamp(): string {
    clock += 1;
    return new Date(now().getTime() + clock).toISOString();
  }

  function collection(name: string) {
    const spec = collections[name];
    if (!spec) throw new FakeRuntimeError("collection_not_found", `Data collection ${name} is not declared.`, 404);
    const fields = spec.fields ?? {};
    const indexedFields = new Set((spec.indexes ?? []).flatMap((index) => index.fields));
    const rows = () => state.rows.get(name)!;

    function validateRow(input: Json): Json {
      const output: Json = {};
      for (const [field, value] of Object.entries(input)) {
        const fieldSpec = fields[field];
        if (fieldSpec === undefined) throw new FakeRuntimeError("invalid_row", `Data row field ${field} is not declared.`);
        if (value === undefined) continue;
        validateFieldValue(field, fieldSpec, value);
        output[field] = value;
      }
      return output;
    }

    function assertUnique(data: Json, rowId: string | null): void {
      for (const index of spec!.indexes ?? []) {
        if (!index.unique) continue;
        if (index.fields.some((field) => data[field] === undefined || data[field] === null)) continue;
        const clash = rows().find((row) => row.id !== rowId && index.fields.every((field) => Object.is(row.data[field], data[field])));
        if (clash) throw new FakeRuntimeError("unique_violation", `Unique index ${index.name} already has this value.`, 409);
      }
    }

    function toRow(id: string, createdAt: string, updatedAt: string, data: Json): FakeRow {
      return { ...data, id, created_at: createdAt, updated_at: updatedAt, data };
    }

    function query(input: { where?: Json; order_by?: Array<{ field: string; direction?: string }>; limit?: number; cursor?: string } = {}) {
      for (const field of Object.keys(input.where ?? {})) {
        if (!(field in fields)) throw new FakeRuntimeError("invalid_query", `Query field ${field} is not declared.`);
        if (!indexedFields.has(field)) throw new FakeRuntimeError("unindexed_query", `Query field ${field} is not indexed.`);
      }
      for (const order of input.order_by ?? []) {
        if (!(order.field in fields) || (order.direction !== undefined && order.direction !== "asc" && order.direction !== "desc")) {
          throw new FakeRuntimeError("invalid_query", "Order field or direction is invalid.");
        }
        if (!indexedFields.has(order.field)) throw new FakeRuntimeError("unindexed_query", `Order field ${order.field} is not indexed.`);
      }
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 100)) {
        throw new FakeRuntimeError("invalid_query", "Query limit must be between 1 and 100.");
      }
      const orderBy = input.order_by ?? [];
      const filtered = rows()
        .filter((row) => Object.entries(input.where ?? {}).every(([field, value]) => Object.is(row.data[field], value)))
        .sort((left, right) => {
          for (const order of orderBy) {
            const direction = order.direction === "desc" ? -1 : 1;
            const a = left.data[order.field];
            const b = right.data[order.field];
            if (a === b) continue;
            return String(a).localeCompare(String(b)) * direction;
          }
          return right.updated_at.localeCompare(left.updated_at);
        });
      const limit = input.limit ?? 50;
      const offset = input.cursor ? Number.parseInt(atob(input.cursor), 10) : 0;
      const page = filtered.slice(offset, offset + limit);
      const next = offset + page.length;
      return { rows: page.map((row) => structuredClone(row)), ...(next < filtered.length ? { cursor: btoa(String(next)) } : {}) };
    }

    return {
      async create(input: Json) {
        const data = validateRow(input);
        sequence += 1;
        const id = `row_${name}_${sequence}`;
        assertUnique(data, id);
        const at = timestamp();
        const row = toRow(id, at, at, data);
        rows().push(row);
        return structuredClone(row);
      },
      async get(id: string) {
        const row = rows().find((candidate) => candidate.id === id);
        return row ? structuredClone(row) : null;
      },
      async update(id: string, patch: Json) {
        const index = rows().findIndex((candidate) => candidate.id === id);
        if (index === -1) throw new FakeRuntimeError("row_not_found", "Data row not found.", 404);
        const data = { ...rows()[index]!.data, ...validateRow(patch) };
        assertUnique(data, id);
        const row = toRow(id, rows()[index]!.created_at, timestamp(), data);
        rows()[index] = row;
        return structuredClone(row);
      },
      async delete(id: string) {
        const index = rows().findIndex((candidate) => candidate.id === id);
        if (index !== -1) rows().splice(index, 1);
      },
      async list(input?: Parameters<typeof query>[0]) {
        return query(input);
      },
      async query(input?: Parameters<typeof query>[0]) {
        return query(input);
      }
    };
  }

  type FakeDataNamespace = {
    app_id: string;
    collection: typeof collection;
    transaction<T>(callback: (tx: FakeDataNamespace) => Promise<T> | T): Promise<T>;
  };
  const data: FakeDataNamespace = {
    app_id: "app_test",
    collection,
    async transaction<T>(callback: (tx: FakeDataNamespace) => Promise<T> | T): Promise<T> {
      const snapshot = new Map([...state.rows].map(([name, rows]) => [name, structuredClone(rows)]));
      try {
        return await callback(data);
      } catch (error) {
        state.rows = snapshot;
        throw error;
      }
    }
  };

  function requireAuthEnabled(): void {
    if (auth.mode !== "app_users") throw new FakeRuntimeError("auth_disabled", "App-user auth is not enabled for this app.", 404);
  }

  const ctx = {
    app: { id: "app_test", app_id: "app_test", origin: "https://app-test.apps.userland.fun", releaseId: "rel_test", release_id: "rel_test" },
    auth: {
      app_id: "app_test",
      async currentUser(_request: Request) {
        requireAuthEnabled();
        return state.user ? structuredClone(state.user) : null;
      },
      async requireUser(request: Request) {
        const user = await ctx.auth.currentUser(request);
        if (!user) throw new FakeRuntimeError("unauthorized", "Authentication required.", 401);
        return user;
      },
      async requireRole(request: Request, role: string) {
        const user = await ctx.auth.requireUser(request);
        if (!user.roles.includes(role)) throw new FakeRuntimeError("forbidden", "Required role is missing.", 403);
        return user;
      }
    },
    data,
    files: {
      app_id: "app_test",
      store(name: string) {
        const store = stores[name];
        if (!store) throw new FakeRuntimeError("store_not_found", `File store ${name} is not declared.`, 404);
        return {
          async createUpload(bytes: ArrayBuffer | Uint8Array | string, options: { filename?: string; path?: string; content_type: string; metadata?: Json }) {
            const contentType = options.content_type.trim().toLowerCase();
            const allowed = store.allowed_content_types ?? [];
            if (allowed.length > 0 && !allowed.includes(contentType.split(";")[0]!.trim())) {
              throw new FakeRuntimeError("content_type_not_allowed", "Content type is not allowed for this store.", 415);
            }
            const size = typeof bytes === "string" ? new TextEncoder().encode(bytes).byteLength : bytes.byteLength;
            if (size > (store.max_file_size_bytes ?? 10 * 1024 * 1024)) throw new FakeRuntimeError("file_too_large", "File exceeds the store size limit.", 413);
            sequence += 1;
            const at = timestamp();
            const file = {
              file_id: `file_${sequence}`,
              id: `file_${sequence}`,
              store_name: name,
              path: options.path ?? options.filename ?? `file_${sequence}`,
              url: `https://files.example.test/${name}/file_${sequence}`,
              content_type: contentType,
              size_bytes: size,
              metadata: options.metadata ?? {},
              created_at: at,
              updated_at: at
            };
            state.files.push(file);
            return file;
          }
        };
      }
    },
    secrets: {
      app_id: "app_test",
      async get(name: string) {
        return options.secrets?.[name];
      },
      async require(name: string) {
        if (!requiredSecrets.has(name)) throw new FakeRuntimeError("undeclared_secret", `Secret ${name} is not declared in resources.secrets.required.`);
        const value = options.secrets?.[name];
        if (value === undefined) throw new FakeRuntimeError("missing_secret", `Secret ${name} is not set.`);
        return value;
      }
    },
    jobs: {
      app_id: "app_test",
      async enqueue(name: string, payload: Json = {}) {
        const spec = jobs[name];
        if (!spec) throw new FakeRuntimeError("job_not_found", `Job ${name} is not declared.`, 404);
        if ((spec.trigger ?? "manual") !== "manual") throw new FakeRuntimeError("invalid_job", "Only manual jobs can be enqueued directly.");
        sequence += 1;
        state.enqueued.push({ name, payload });
        return { job_id: `job_${sequence}`, name, status: "queued" as const, run_after: now().toISOString() };
      }
    },
    webhooks: { app_id: "app_test" },
    log: {
      async debug(message: string, metadata?: Json) {
        state.logs.push({ level: "debug", message, metadata });
      },
      async info(message: string, metadata?: Json) {
        state.logs.push({ level: "info", message, metadata });
      },
      async warn(message: string, metadata?: Json) {
        state.logs.push({ level: "warn", message, metadata });
      },
      async error(message: string, metadata?: Json) {
        state.logs.push({ level: "error", message, metadata });
      }
    }
  };

  return {
    ctx,
    state,
    setUser(user: FakeAppUser | null) {
      state.user = user;
    }
  };
}

// Builds the job event that Userland passes to `job(event, ctx)` when a
// manifest webhook uses `deliver_to: "job"`. The verified request body is under
// `event.payload.payload`; signature headers are redacted before delivery.
export function webhookJobEvent(input: { job: string; webhook: string; body: unknown; headers?: Record<string, string> }) {
  return {
    job_id: "job_webhook_1",
    name: input.job,
    payload: {
      webhook_delivery_id: "whd_test_1",
      name: input.webhook,
      headers: input.headers ?? { "content-type": "application/json" },
      payload: input.body
    }
  };
}

// Sends the same request as GET and then as HEAD, and checks that HEAD got
// GET's status and headers with an empty body. Userland hands a server's
// response back as the server built it, so each example answers HEAD itself
// (link checkers and uptime monitors send HEAD). Returns the GET response.
export async function expectHeadLikeGet(
  server: { fetch(request: Request, ctx: never): Promise<Response> },
  ctx: unknown,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const get = await server.fetch(new Request(url, { ...init, method: "GET" }), ctx as never);
  const head = await server.fetch(new Request(url, { ...init, method: "HEAD" }), ctx as never);
  expect({ url, status: head.status, headers: headerObject(head.headers), body: await head.text() }).toEqual({
    url,
    status: get.status,
    headers: headerObject(get.headers),
    body: ""
  });
  return get;
}

function headerObject(headers: Headers): Record<string, string> {
  const object: Record<string, string> = {};
  headers.forEach((value, name) => {
    object[name] = value;
  });
  return object;
}

function validateFieldValue(field: string, spec: string | { type: string; values?: string[] }, value: unknown): void {
  const objectSpec = typeof spec === "string" ? { type: spec } : spec;
  switch (objectSpec.type) {
    case "string":
    case "richtext":
    case "datetime":
    case "reference":
      if (typeof value !== "string") throw new FakeRuntimeError("invalid_row", `Data row field ${field} must be a string.`);
      return;
    case "integer":
      if (!Number.isInteger(value)) throw new FakeRuntimeError("invalid_row", `Data row field ${field} must be an integer.`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new FakeRuntimeError("invalid_row", `Data row field ${field} must be a number.`);
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new FakeRuntimeError("invalid_row", `Data row field ${field} must be a boolean.`);
      return;
    case "json":
      return;
    case "enum":
      if (typeof value !== "string" || !objectSpec.values?.includes(value)) throw new FakeRuntimeError("invalid_row", `Data row field ${field} enum value is invalid.`);
      return;
  }
}

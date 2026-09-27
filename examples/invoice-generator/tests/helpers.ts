// Shared helpers for the invoice-generator tests.
import path from "node:path";
import { createFakeRuntime, readExampleManifest, type FakeAppUser } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

export const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

// A fake Userland runtime built from this example's manifest (declared fields,
// indexed queries, unique indexes, and auth roles are enforced), with spies on
// the auth helpers so tests can check how the owner gate uses them.
export function makeCtx(options: { user?: FakeAppUser | null } = {}) {
  const runtime = createFakeRuntime(manifest, { user: options.user ?? null });
  const ctx = runtime.ctx as typeof runtime.ctx & { runtime: typeof runtime };
  ctx.runtime = runtime;
  vi.spyOn(ctx.auth, "requireRole");
  vi.spyOn(ctx.auth, "currentUser");
  return ctx;
}

export type FakeCtx = ReturnType<typeof makeCtx>;

export function rows(ctx: FakeCtx, name: "clients" | "documents") {
  return ctx.runtime.state.rows.get(name)!;
}

export function row(ctx: FakeCtx, name: "clients" | "documents", id: string) {
  return rows(ctx, name).find((item) => item.id === id);
}

/** A form POST, as a browser sends it. */
export function post(url: string, fields: Record<string, string | string[]>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return new Request(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
}

export const SITE = "https://invoices.example.test";
export const DEMO = "https://invoice-demo.apps.userland.fun";
export const OWNER = { id: "appusr_owner", app_user_id: "appusr_owner", email: "owner@example.com", roles: ["owner"] };

export async function send(ctx: FakeCtx, request: Request | string) {
  return await app.fetch(typeof request === "string" ? new Request(request) : request, ctx);
}

export async function text(response: Response) {
  return await response.text();
}

export function location(response: Response) {
  return response.headers.get("location") ?? "";
}

export async function requestQuote(ctx: FakeCtx, base: string, fields: Record<string, string> = {}) {
  return await send(
    ctx,
    post(`${base}/request`, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      company: "Analytical Bakery",
      service: "packaging",
      message: "Boxes for our spring range.",
      website: "",
      ...fields
    })
  );
}

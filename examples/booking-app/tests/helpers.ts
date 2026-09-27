// Shared helpers for the booking-app tests.
import path from "node:path";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";

export const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

// Monday, September 28, 2026, 10:00 am in the studio (Pacific time).
export const NOW = new Date("2026-09-28T17:00:00.000Z");
export const ORIGIN = "https://booking-demo.apps.userland.fun";
export const OWNER = { id: "user_owner", app_user_id: "user_owner", email: "nora@example.com", roles: ["owner"] };
export const STUDENT = { id: "user_student", app_user_id: "user_student", email: "sam@example.com", roles: [] };

export type Runtime = ReturnType<typeof createFakeRuntime>;

/**
 * A fake Userland runtime for the app. Two changes make it behave like the
 * platform where this app depends on it:
 * - a duplicate unique value throws `code: "unique_conflict"`, as `ctx.data` does;
 * - with `limits.maxRows`, a create past that many saved rows throws
 *   `code: "quota_exceeded"`, like a plan's data row limit. Tests can change
 *   `limits.maxRows` as they go.
 */
export function runtime(limits: { maxRows?: number } = {}) {
  const rt = createFakeRuntime(manifest, { now: () => NOW });
  const data = rt.ctx.data as any;
  const collection = data.collection;
  const platformError = (error: any) => (error?.code === "unique_violation" ? Object.assign(new Error(error.message), { code: "unique_conflict" }) : error);
  data.collection = (name: string) => {
    const inner = collection(name);
    return {
      ...inner,
      async create(input: Record<string, unknown>) {
        const saved = [...rt.state.rows.values()].reduce((total, list) => total + list.length, 0);
        if (limits.maxRows !== undefined && saved >= limits.maxRows) throw Object.assign(new Error("Data row limit reached."), { code: "quota_exceeded" });
        try {
          return await inner.create(input);
        } catch (error) {
          throw platformError(error);
        }
      },
      async update(id: string, patch: Record<string, unknown>) {
        try {
          return await inner.update(id, patch);
        } catch (error) {
          throw platformError(error);
        }
      }
    };
  };
  return rt;
}

export function rows(rt: Runtime, collection: string) {
  return rt.state.rows.get(collection)!;
}

/** Lesson requests, without the time holds that share their collection. */
export function requests(rt: Runtime) {
  return rows(rt, "bookings").filter((row) => row.data.status !== "hold");
}

/** Time holds: one row per half-hour block a request holds. */
export function holds(rt: Runtime) {
  return rows(rt, "bookings").filter((row) => row.data.status === "hold");
}

export function logged(rt: Runtime, message: string) {
  return rt.state.logs.filter((entry) => entry.message === message);
}

export function get(app: any, rt: Runtime, pathname: string, origin = ORIGIN) {
  return app.fetch(new Request(`${origin}${pathname}`), rt.ctx) as Promise<Response>;
}

export function post(app: any, rt: Runtime, pathname: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`${ORIGIN}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
      body: new URLSearchParams(form).toString()
    }),
    rt.ctx
  ) as Promise<Response>;
}

export async function openTime(app: any, rt: Runtime) {
  const page = await (await get(app, rt, "/book")).text();
  return {
    service_id: page.match(/name="service_id" value="([^"]+)"/u)![1]!,
    date: page.match(/name="date" value="([^"]+)"/u)![1]!,
    time: page.match(/name="time" value="([^"]+)"/u)![1]!
  };
}

export async function book(app: any, rt: Runtime, details: Record<string, string>) {
  const slot = await openTime(app, rt);
  return await post(app, rt, "/book", { ...slot, customer_email: "ada@example.com", student_details: "Me, adult beginner", ...details });
}

/** Every inbox tab's HTML, joined, for checks that don't care which tab a request is under. */
export async function allTabs(app: any, rt: Runtime, key?: string | null) {
  const pages = [];
  for (const tab of ["new", "upcoming", "past", "declined", "cancelled"]) {
    pages.push(await (await get(app, rt, `/studio?show=${tab}${key ? `&v=${key}` : ""}`)).text());
  }
  return pages.join("\n");
}

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

export function runtime() {
  return createFakeRuntime(manifest, { now: () => NOW });
}

export function rows(rt: Runtime, collection: string) {
  return rt.state.rows.get(collection)!;
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { STARTER_SERVICES, createApp, validateBooking } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { studioTimeToDate } from "../server/schedule.js";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
import { NOW, ORIGIN, OWNER, STUDENT, book, get, logged, openTime, post, rows, runtime, type Runtime } from "./helpers.js";

// A studio outside demo mode. Demo-mode tests live in demo.test.ts.

async function addLessons(rt: Runtime) {
  const services = rt.ctx.data.collection("services");
  for (const [index, service] of (STARTER_SERVICES as Array<Record<string, unknown>>).entries()) {
    await services.create({ ...service, sort_order: index + 1, active: true, demo_key: "" });
  }
}

/** Runs the public booking flow and the owner's work on an app outside demo mode. */
async function studioFlow(app: any) {
  const rt = runtime();
  rt.setUser(OWNER);
  expect((await post(app, rt, "/studio/lessons/starter", {})).status).toBe(303);
  expect(rows(rt, "services")).toHaveLength(4);
  rt.setUser(null);

  const home = await get(app, rt, "/");
  expect(home.status).toBe(200);
  const homeHtml = await home.text();
  expect(homeHtml).toContain("Voice lesson");
  expect(homeHtml).not.toContain("noindex");
  expect(homeHtml).not.toContain("Built with Userland");

  const booked = await book(app, rt, { customer_name: "Ada Lovelace" });
  expect(booked.status).toBe(303);
  const location = booked.headers.get("location")!;
  expect(location).toMatch(/^\/booked\?ref=WH-[A-Z0-9]{6}$/u);
  const confirmation = await get(app, rt, location);
  expect(confirmation.status).toBe(200);
  expect(await confirmation.text()).toContain("Thank you, Ada.");

  const booking = rows(rt, "bookings")[0]!;
  const signedOut = await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed" });
  expect(signedOut.headers.get("location")).toMatch(/^\/_userland\/auth\/login/u);

  rt.setUser(OWNER);
  const inbox = await (await get(app, rt, "/studio")).text();
  expect(inbox).toContain("Ada Lovelace");
  expect(inbox).not.toContain("Priya Raman"); // No demo samples.
  const confirmed = await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed", show: "new" });
  expect(confirmed.status).toBe(303);
  expect(rows(rt, "bookings")[0]!.data.status).toBe("confirmed");

  const lesson = rows(rt, "services").find((row) => row.data.name === "First lesson")!;
  const edit = await post(app, rt, `/studio/lessons/${lesson.id}`, { name: "Trial lesson", summary: "", duration_minutes: "30", price: "30", active: "yes" });
  expect(edit.status).toBe(303);
  expect(rows(rt, "services").find((row) => row.id === lesson.id)!.data.name).toBe("Trial lesson");
  const added = await post(app, rt, "/studio/lessons", { name: "Duet lesson", summary: "", duration_minutes: "60", price: "90", active: "yes" });
  expect(added.status).toBe(303);
  expect(await (await get(app, rt, "/studio/lessons")).text()).toContain("Duet lesson");
  expect(await (await get(app, rt, "/studio/activity")).text()).toContain("Ada Lovelace");
  return rt;
}

describe("public booking flow", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  it("takes a request and shows a confirmation", async () => {
    const rt = runtime();
    await addLessons(rt);
    const response = await book(app, rt, { customer_name: "Ada Lovelace" });
    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/booked\?ref=WH-[A-Z0-9]{6}$/u);

    const confirmation = await (await get(app, rt, location)).text();
    expect(confirmation).toContain("Thank you, Ada.");
    expect(confirmation).toContain("a•••@example.com");
    expect(confirmation).not.toContain("ada@example.com");
    expect(rows(rt, "bookings")[0]!.data).toMatchObject({ demo_key: "", status: "new" });

    // The activity log gets ids only, never contact details.
    const [entry] = logged(rt, "booking requested");
    expect(entry!.metadata).toMatchObject({ booking_id: rows(rt, "bookings")[0]!.id });
    expect(JSON.stringify(entry!.metadata)).not.toContain("example.com");
  });

  it("validates input and escapes what visitors type", async () => {
    const rt = runtime();
    await addLessons(rt);
    const slot = await openTime(app, rt);
    const invalid = await post(app, rt, "/book", { ...slot, customer_name: "", customer_email: "not-an-email", student_details: "" });
    expect(invalid.status).toBe(422);
    const html = await invalid.text();
    expect(html).toContain("Please enter your name.");
    expect(html).toContain("Please enter an email address");

    // Errors are listed in form order, starting with the lesson.
    const noLesson = await (await post(app, rt, "/book", { ...slot, service_id: "missing", customer_name: "" })).text();
    expect(noLesson.indexOf("Please choose a lesson")).toBeLessThan(noLesson.indexOf("Please enter your name"));

    const tooLong = validateBooking({ ...slot, customer_name: "x".repeat(81), customer_email: "a@example.com", student_details: "Me" });
    expect(tooLong.errors.customer_name).toMatch(/under 80/u);

    await book(app, rt, { customer_name: '<script>alert("hi")</script>' });
    rt.setUser(OWNER);
    const inbox = await (await get(app, rt, "/studio")).text();
    expect(inbox).not.toContain("<script>alert");
    expect(inbox).toContain("&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;");
  });

  it("quietly drops requests that fill in the hidden honeypot field", async () => {
    const rt = runtime();
    await addLessons(rt);
    const response = await book(app, rt, { customer_name: "Bot", company: "Spam Inc" });
    expect(response.status).toBe(200);
    expect(rows(rt, "bookings")).toHaveLength(0);
  });

  it("does not hand out the same time twice", async () => {
    const rt = runtime();
    await addLessons(rt);
    const slot = await openTime(app, rt);
    expect((await book(app, rt, { customer_name: "First" })).status).toBe(303);
    const again = await post(app, rt, "/book", { ...slot, customer_name: "Second", customer_email: "b@example.com", student_details: "Me" });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("that time was just taken");
    expect(rows(rt, "bookings")).toHaveLength(1);
  });

  it("rejects form posts from other sites", async () => {
    const rt = runtime();
    await addLessons(rt);
    const slot = await openTime(app, rt);
    const response = await post(app, rt, "/book", { ...slot, customer_name: "Ada", customer_email: "a@example.com", student_details: "Me" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(rows(rt, "bookings")).toHaveLength(0);
  });
});

describe("owner pages outside demo mode", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  it("sends signed-out visitors to sign in", async () => {
    const rt = runtime();
    for (const pathname of ["/studio", "/studio/lessons", "/studio/activity"]) {
      const response = await get(app, rt, pathname);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/_userland/auth/login?return_to=${encodeURIComponent(pathname)}`);
    }
  });

  it("blocks owner actions without an owner session", async () => {
    const rt = runtime();
    const booking = await rt.ctx.data.collection("bookings").create({
      ref: "WH-AAAAAA",
      status: "new",
      customer_name: "Real Customer",
      starts_at: "2026-10-01T22:00:00.000Z",
      ends_at: "2026-10-01T22:45:00.000Z",
      history: [],
      demo_key: ""
    });
    const status = () => rows(rt, "bookings")[0]!.data.status;

    const signedOut = await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed" });
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toMatch(/^\/_userland\/auth\/login/u);
    expect(status()).toBe("new");

    rt.setUser(STUDENT);
    const notOwner = await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed" });
    expect(notOwner.status).toBe(403);
    expect(status()).toBe("new");

    rt.setUser(OWNER);
    const owner = await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed" });
    expect(owner.status).toBe(303);
    expect(status()).toBe("confirmed");
    expect(logged(rt, "booking status changed")[0]!.metadata).toMatchObject({ from: "new", to: "confirmed" });
  });

  it("treats rows saved without a demo_key as the studio's own", async () => {
    const rt = runtime();
    rt.setUser(OWNER);
    const booking = await rt.ctx.data.collection("bookings").create({ ref: "WH-BBBBBB", status: "new", customer_name: "No Key", starts_at: "2026-10-01T22:00:00.000Z", ends_at: "2026-10-01T22:45:00.000Z", history: [] });
    expect((await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed" })).status).toBe(303);
    expect(rows(rt, "bookings")[0]!.data.status).toBe("confirmed");
    expect((await get(app, rt, "/booked?ref=WH-BBBBBB")).status).toBe(200);
  });

  it("shows the inbox to the owner and keeps public pages indexable", async () => {
    const rt = runtime();
    rt.setUser(OWNER);
    const inbox = await get(app, rt, "/studio");
    expect(inbox.status).toBe(200);
    const html = await inbox.text();
    expect(html).toContain("Booking requests");
    expect(html).toContain('content="noindex,follow"');
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Built with Userland");

    const home = await (await get(app, rt, "/")).text();
    expect(home).not.toContain("noindex");
    expect(home).not.toContain("demo booking site");
  });

  it("lets the owner run the studio: starter lessons, bookings, status changes, and lesson edits", async () => {
    await studioFlow(app);
  });
});

describe("HEAD requests", () => {
  it("answer every page like GET, without a body", async () => {
    const app = createApp({ demoMode: false, now: () => NOW });
    const rt = runtime();
    await addLessons(rt);
    const location = (await book(app, rt, { customer_name: "Ada Lovelace" })).headers.get("location")!;
    const pages: Array<[string, number]> = [
      ["/", 200],
      ["/book", 200],
      [location, 200],
      ["/studio", 303],
      ["/studio/lessons", 303],
      ["/missing", 404]
    ];
    for (const [pathname, status] of pages) {
      expect((await expectHeadLikeGet(app, rt.ctx, `${ORIGIN}${pathname}`)).status).toBe(status);
    }
    rt.setUser(OWNER);
    for (const pathname of ["/studio", "/studio/lessons", "/studio/activity"]) {
      expect((await expectHeadLikeGet(app, rt.ctx, `${ORIGIN}${pathname}`)).status).toBe(200);
    }
  });

  it("answer the demo like GET, without a body", async () => {
    const app = createApp({ demoMode: true, now: () => NOW });
    const rt = runtime();
    for (const pathname of ["/", "/book", "/studio"]) {
      expect((await expectHeadLikeGet(app, rt.ctx, `${ORIGIN}${pathname}`)).status).toBe(200);
    }
  });
});

describe("removing demo mode", () => {
  // Follows the steps in README.md: delete server/demo.js and every line that
  // ends in `// demo`, then checks the studio still works with the owner sign-in.
  async function strippedApp() {
    const source = path.resolve(import.meta.dirname, "../server");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "booking-app-no-demo-"));
    for (const name of fs.readdirSync(source)) {
      if (name === "demo.js") continue;
      const code = fs.readFileSync(path.join(source, name), "utf8");
      const kept = code.split("\n").filter((line) => !/\/\/ demo$/u.test(line.trimEnd()));
      fs.writeFileSync(path.join(target, name), kept.join("\n"));
    }
    const stripped = fs.readFileSync(path.join(target, "index.js"), "utf8");
    expect(stripped).not.toMatch(/\bdemo\.(?!js\b)/u); // No code uses the demo module.
    const module = await import(pathToFileURL(path.join(target, "index.js")).href);
    return module.createApp({ now: () => NOW });
  }

  it("still runs the whole studio after the demo lines are deleted, even at the demo address", async () => {
    const app = await strippedApp();
    const rt = await studioFlow(app);
    expect(rows(rt, "bookings").every((row) => row.data.demo_key === "")).toBe(true);

    // With demo mode gone, the demo address needs the owner sign-in too.
    rt.setUser(null);
    const gated = await get(app, rt, "/studio");
    expect(gated.status).toBe(303);
    expect(gated.headers.get("location")).toContain("/_userland/auth/login");
  });
});

describe("studio time", () => {
  it("converts studio wall-clock times across daylight saving time", () => {
    expect(studioTimeToDate("2026-10-01", "15:00").toISOString()).toBe("2026-10-01T22:00:00.000Z");
    expect(studioTimeToDate("2026-11-02", "15:00").toISOString()).toBe("2026-11-02T23:00:00.000Z");
  });
});

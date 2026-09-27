import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { CLEAR_OUT, REQUEST_LIMITS, STARTER_SERVICES, createApp, validateBooking } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { openDays, slotsForDay, studioTimeToDate } from "../server/schedule.js";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
import { NOW, ORIGIN, OWNER, STUDENT, allTabs, book, get, holds, logged, openTime, post, requests, rows, runtime, type Runtime } from "./helpers.js";

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

  const booking = requests(rt)[0]!;
  const signedOut = await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed" });
  expect(signedOut.headers.get("location")).toMatch(/^\/_userland\/auth\/login/u);

  rt.setUser(OWNER);
  const inbox = await (await get(app, rt, "/studio")).text();
  expect(inbox).toContain("Ada Lovelace");
  expect(inbox).not.toContain("Priya Raman"); // No demo samples.
  const confirmed = await post(app, rt, `/studio/bookings/${booking.id}/status`, { status: "confirmed", show: "new" });
  expect(confirmed.status).toBe(303);
  expect(requests(rt)[0]!.data.status).toBe("confirmed");

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
    expect(requests(rt)[0]!.data).toMatchObject({ demo_key: "", status: "new" });

    // The activity log gets ids only, never contact details.
    const [entry] = logged(rt, "booking requested");
    expect(entry!.metadata).toMatchObject({ booking_id: requests(rt)[0]!.id });
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
    expect(requests(rt)).toHaveLength(1);
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
    const status = () => requests(rt)[0]!.data.status;

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
    expect(requests(rt)[0]!.data.status).toBe("confirmed");
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
    expect(stripped).not.toMatch(/demo\.js|DEMO_HOSTS/u); // No comment points at the deleted file.
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

// ---------------------------------------------------------------------------
// Audit fixes: double booking, long histories, reopening, limits, and forms.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
// Tuesday, September 29, 2026 in the studio: the first open day past the 24-hour notice.
const TUESDAY = "2026-09-29";
const TUESDAY_3PM = "2026-09-29T22:00:00.000Z";

function service(rt: Runtime, name: string) {
  return rows(rt, "services").find((row) => row.data.name === name)!;
}

/** Saves requests straight to data, like a studio that has been running for a while. */
async function seedBookings(rt: Runtime, count: number, fields: (index: number) => Record<string, unknown>) {
  const bookings = rt.ctx.data.collection("bookings");
  for (let index = 0; index < count; index += 1) {
    const extra = fields(index);
    const starts = String(extra.starts_at);
    await bookings.create({
      ref: `WH-S${String(index).padStart(5, "0")}`,
      service_id: "old",
      service_name: "Piano lesson",
      duration_minutes: 30,
      price_cents: 6000,
      ends_at: new Date(Date.parse(starts) + 30 * 60 * 1000).toISOString(),
      customer_name: `Student ${index}`,
      customer_email: `student${index}@example.com`,
      customer_phone: "",
      student_details: "Me",
      message: "",
      status: "confirmed",
      history: [{ at: starts, status: "new", by: "customer" }],
      demo_key: "",
      ...extra
    });
  }
}

function request(fields: Record<string, string>) {
  return { customer_name: "Ada Lovelace", customer_email: "ada@example.com", student_details: "Me, adult beginner", ...fields };
}

describe("double-booking protection", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  it("gives a time to only one of two requests sent at the same moment", async () => {
    const rt = runtime();
    await addLessons(rt);
    const slot = await openTime(app, rt);
    const responses = await Promise.all([
      post(app, rt, "/book", { ...slot, ...request({ customer_name: "First", customer_email: "first@example.com" }) }),
      post(app, rt, "/book", { ...slot, ...request({ customer_name: "Second", customer_email: "second@example.com" }) })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([303, 409]);
    expect(requests(rt)).toHaveLength(1);
    // A 30-minute lesson holds one half-hour block, owned by the request that won.
    expect(holds(rt).map((row) => row.data.hold_for)).toEqual([requests(rt)[0]!.data.ref]);
  });

  it("gives overlapping lessons of different lengths to only one request", async () => {
    const rt = runtime();
    await addLessons(rt);
    const responses = await Promise.all([
      post(app, rt, "/book", request({ service_id: service(rt, "Extended lesson").id, date: TUESDAY, time: "15:00", customer_email: "long@example.com" })),
      post(app, rt, "/book", request({ service_id: service(rt, "Piano lesson").id, date: TUESDAY, time: "15:30", customer_email: "short@example.com" }))
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([303, 409]);
    expect(requests(rt)).toHaveLength(1);
  });

  it("frees the time again when a request is declined, and clears holds for lessons that are over", async () => {
    const rt = runtime();
    await addLessons(rt);
    const slot = await openTime(app, rt);
    await post(app, rt, "/book", { ...slot, ...request({ customer_name: "First" }) });
    const first = requests(rt)[0]!;
    expect(holds(rt)).toHaveLength(1);

    rt.setUser(OWNER);
    await post(app, rt, `/studio/bookings/${first.id}/status`, { status: "declined", show: "new" });
    expect(holds(rt)).toHaveLength(0);
    rt.setUser(null);
    expect((await post(app, rt, "/book", { ...slot, ...request({ customer_name: "Second", customer_email: "b@example.com" }) })).status).toBe(303);

    // A hold left from a lesson last week is deleted on the next request.
    await rt.ctx.data.collection("bookings").create({ hold: `|${ago(7 * DAY)}`, hold_for: "WH-OLD000", status: "hold", starts_at: ago(7 * DAY), ends_at: ago(7 * DAY - HOUR / 2), demo_key: "" });
    await book(app, rt, request({ customer_email: "c@example.com" }));
    expect(holds(rt).every((row) => Date.parse(String(row.data.ends_at)) > NOW.getTime())).toBe(true);
  });
});

describe("a studio with a long history", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  async function busyStudio() {
    const rt = runtime();
    await addLessons(rt);
    // 520 past lessons, more than any single read returns.
    await seedBookings(rt, 520, (index) => ({ starts_at: ago((index + 2) * DAY) }));
    // A confirmed lesson on Tuesday at 3 pm, saved after all of them.
    await seedBookings(rt, 1, () => ({ ref: "WH-TUE300", starts_at: TUESDAY_3PM, customer_name: "Tuesday Student" }));
    return rt;
  }

  it("still sees upcoming lessons when checking open times", async () => {
    const rt = await busyStudio();
    const slot = await openTime(app, rt);
    expect(slot).toMatchObject({ date: TUESDAY, time: "15:30" });
    const taken = await post(app, rt, "/book", request({ service_id: slot.service_id, date: TUESDAY, time: "15:00" }));
    expect(taken.status).toBe(409);
  });

  it("shows new requests in the inbox and the activity page", async () => {
    const rt = await busyStudio();
    expect((await book(app, rt, request({ customer_name: "Newest Student" }))).status).toBe(303);
    rt.setUser(OWNER);
    const inbox = await (await get(app, rt, "/studio")).text();
    expect(inbox).toContain("Newest Student");
    expect(inbox).toContain('<span class="count">1</span>');
    expect(await (await get(app, rt, "/studio?show=upcoming")).text()).toContain("Tuesday Student");
    const activity = await (await get(app, rt, "/studio/activity")).text();
    expect(activity).toContain("Newest Student");
  });

  it("pages through every past lesson with Show more", async () => {
    const rt = await busyStudio();
    rt.setUser(OWNER);
    const seen = new Set<string>();
    let next: string | null = "/studio?show=past";
    let pages = 0;
    while (next) {
      const html = await (await get(app, rt, next)).text();
      for (const match of html.matchAll(/<li class="booking" id="booking-([^"]+)"/gu)) seen.add(match[1]!);
      next = html.match(/href="(\/studio\?show=past&amp;after=[^"]+)"/u)?.[1]?.replaceAll("&amp;", "&") ?? null;
      pages += 1;
    }
    expect(seen.size).toBe(520);
    expect(pages).toBe(Math.ceil(520 / 25));
  });

  it("starts a list over when a Show more link no longer works", async () => {
    const rt = await busyStudio();
    rt.setUser(OWNER);
    const broken = await get(app, rt, "/studio?show=past&after=not-a-real-place");
    expect(broken.status).toBe(303);
    expect(broken.headers.get("location")).toBe("/studio?show=past");
  });

  it("lets the owner clear out old requests a batch at a time", async () => {
    const rt = runtime();
    await seedBookings(rt, CLEAR_OUT.batch + 5, (index) => ({ status: "declined", starts_at: ago((40 + index) * DAY) }));
    await seedBookings(rt, 2, (index) => ({ ref: `WH-REC00${index}`, status: "declined", starts_at: ago((index + 1) * DAY) }));
    rt.setUser(OWNER);
    const clear = () => post(app, rt, "/studio/bookings/clear-out", { show: "declined" });

    const first = await clear();
    expect(first.headers.get("location")).toBe(`/studio?show=declined&notice=cleared&count=${CLEAR_OUT.batch}&more=1`);
    expect(await (await get(app, rt, first.headers.get("location")!)).text()).toContain(`Deleted ${CLEAR_OUT.batch} old declined requests.`);
    expect((await clear()).headers.get("location")).toBe("/studio?show=declined&notice=cleared&count=5");
    const nothing = await clear();
    expect(await (await get(app, rt, nothing.headers.get("location")!)).text()).toContain("Nothing to clear out");
    // Requests from the last 30 days stay.
    expect(requests(rt)).toHaveLength(2);
  });

  it("lets the owner delete a request, but not a lesson that is still to come", async () => {
    const rt = runtime();
    await addLessons(rt);
    await book(app, rt, request({ customer_name: "Spam Bot" }));
    await seedBookings(rt, 1, () => ({ ref: "WH-TUE300", starts_at: "2026-10-01T22:00:00.000Z", customer_name: "Thursday Student" }));
    const [spam, upcoming] = requests(rt);
    rt.setUser(OWNER);

    expect(await (await get(app, rt, "/studio?show=upcoming")).text()).not.toContain(`/studio/bookings/${upcoming!.id}/delete`);
    await post(app, rt, `/studio/bookings/${upcoming!.id}/delete`, { show: "upcoming" });
    expect(requests(rt).map((row) => row.id)).toContain(upcoming!.id);

    const deleted = await post(app, rt, `/studio/bookings/${spam!.id}/delete`, { show: "new" });
    expect(deleted.headers.get("location")).toBe("/studio?show=new&notice=deleted");
    expect(requests(rt).map((row) => row.id)).toEqual([upcoming!.id]);
    expect(holds(rt)).toHaveLength(0); // The deleted request's time is free again.
    expect(logged(rt, "booking deleted")[0]!.metadata).toMatchObject({ booking_id: spam!.id });
  });
});

describe("reopening a request", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  it("won't move a request back to new when its time has gone to someone else", async () => {
    const rt = runtime();
    await addLessons(rt);
    const slot = await openTime(app, rt);
    await post(app, rt, "/book", { ...slot, ...request({ customer_name: "First Asker" }) });
    const first = requests(rt)[0]!;
    rt.setUser(OWNER);
    await post(app, rt, `/studio/bookings/${first.id}/status`, { status: "declined", show: "new" });

    rt.setUser(null);
    expect((await post(app, rt, "/book", { ...slot, ...request({ customer_name: "Second Asker", customer_email: "b@example.com" }) })).status).toBe(303);
    const second = requests(rt).find((row) => row.data.customer_name === "Second Asker")!;

    rt.setUser(OWNER);
    const reopen = await post(app, rt, `/studio/bookings/${first.id}/status`, { status: "new", show: "declined" });
    expect(reopen.headers.get("location")).toBe(`/studio?show=declined&notice=taken#booking-${first.id}`);
    expect(requests(rt).find((row) => row.id === first.id)!.data.status).toBe("declined");
    expect(await (await get(app, rt, "/studio?show=declined&notice=taken")).text()).toContain("Someone else has that time now");

    // Once the other request is declined, the first can be reopened and holds the time again.
    await post(app, rt, `/studio/bookings/${second.id}/status`, { status: "declined", show: "new" });
    await post(app, rt, `/studio/bookings/${first.id}/status`, { status: "new", show: "declined" });
    expect(requests(rt).find((row) => row.id === first.id)!.data.status).toBe("new");
    expect(holds(rt).map((row) => row.data.hold_for)).toEqual([first.data.ref]);
  });

  it("won't confirm two requests saved for the same time before holds existed", async () => {
    const rt = runtime();
    await seedBookings(rt, 2, (index) => ({ ref: `WH-OLD00${index}`, status: "new", starts_at: TUESDAY_3PM }));
    const [first, second] = requests(rt);
    rt.setUser(OWNER);
    await post(app, rt, `/studio/bookings/${first!.id}/status`, { status: "confirmed", show: "new" });
    const refused = await post(app, rt, `/studio/bookings/${second!.id}/status`, { status: "confirmed", show: "new" });
    expect(refused.headers.get("location")).toContain("notice=taken");
    expect(requests(rt).map((row) => row.data.status)).toEqual(["confirmed", "new"]);
  });
});

describe("limits on unanswered requests", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  it("takes only a few unanswered requests from one email address", async () => {
    const rt = runtime();
    await addLessons(rt);
    for (let index = 0; index < REQUEST_LIMITS.waitingPerEmail; index += 1) {
      expect((await book(app, rt, request({ customer_email: "Same@Example.com" }))).status).toBe(303);
    }
    const refused = await book(app, rt, request({ customer_email: "same@example.com" }));
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("You already have a few requests waiting");
    expect(requests(rt)).toHaveLength(REQUEST_LIMITS.waitingPerEmail);
    expect((await book(app, rt, request({ customer_email: "someone.else@example.com" }))).status).toBe(303);
  });

  it("pauses online booking while too many requests wait, and tells the owner", async () => {
    const rt = runtime();
    await addLessons(rt);
    // Unanswered requests from earlier in the week, for times already past.
    await seedBookings(rt, REQUEST_LIMITS.waitingTotal, (index) => ({ status: "new", starts_at: ago(DAY + index * HOUR), history: [{ at: ago(3 * DAY), status: "new", by: "customer" }] }));
    const refused = await book(app, rt, request({}));
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("online booking is paused");

    rt.setUser(OWNER);
    const inbox = await (await get(app, rt, "/studio")).text();
    expect(inbox).toContain("New requests are paused.");
    await post(app, rt, `/studio/bookings/${requests(rt)[0]!.id}/delete`, { show: "new" });
    rt.setUser(null);
    expect((await book(app, rt, request({}))).status).toBe(303);
  });

  it("limits how many unanswered requests arrive in one day", async () => {
    const rt = runtime();
    await addLessons(rt);
    await seedBookings(rt, REQUEST_LIMITS.receivedPerDay, (index) => ({ status: "new", starts_at: ago(DAY + index * HOUR), history: [{ at: ago(HOUR), status: "new", by: "customer" }] }));
    expect((await book(app, rt, request({}))).status).toBe(429);
  });

  /** `count` different open times for a 30-minute first lesson. */
  function openTimes(rt: Runtime, count: number) {
    const serviceId = service(rt, "First lesson").id;
    const times = (openDays(NOW) as string[]).flatMap((date) =>
      (slotsForDay(date, 30, [], NOW) as Array<{ time: string; available: boolean }>).filter((slot) => slot.available).map((slot) => ({ service_id: serviceId, date, time: slot.time }))
    );
    expect(times.length).toBeGreaterThanOrEqual(count);
    return times.slice(0, count);
  }

  it("keeps to the limits when many requests for different times arrive at the same moment", async () => {
    const rt = runtime();
    await addLessons(rt);
    const burst = await Promise.all(openTimes(rt, REQUEST_LIMITS.waitingTotal + 10).map((time, index) => post(app, rt, "/book", { ...time, ...request({ customer_email: `burst${index}@example.com` }) })));
    expect(burst.every((response) => response.status === 303 || response.status === 429)).toBe(true);
    expect(requests(rt).length).toBeLessThanOrEqual(REQUEST_LIMITS.receivedPerDay);
    // Requests that were taken back gave back their time too.
    expect(new Set(holds(rt).map((row) => row.data.hold_for))).toEqual(new Set(requests(rt).map((row) => row.data.ref)));

    const sameEmail = runtime();
    await addLessons(sameEmail);
    await Promise.all(openTimes(sameEmail, REQUEST_LIMITS.waitingPerEmail + 3).map((time) => post(app, sameEmail, "/book", { ...time, ...request({}) })));
    expect(requests(sameEmail).length).toBeLessThanOrEqual(REQUEST_LIMITS.waitingPerEmail);
    expect(holds(sameEmail)).toHaveLength(requests(sameEmail).length);
  });

  it("explains a full plan instead of failing, and leaves no stray holds", async () => {
    const limits = { maxRows: 5 };
    const rt = runtime(limits);
    await addLessons(rt); // 4 lessons: room for one hold, but not the request itself.
    const response = await book(app, rt, request({}));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Online booking is paused");
    expect(rows(rt, "bookings")).toHaveLength(0);
    expect(logged(rt, "storage limit reached")).toHaveLength(1);

    // The owner is told how to make room.
    limits.maxRows = 4;
    rt.setUser(OWNER);
    const refused = await post(app, rt, "/studio/lessons", { name: "Duet lesson", summary: "", duration_minutes: "60", price: "90", active: "yes" });
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain("Clear out old requests");
    expect(rows(rt, "services")).toHaveLength(4);
  });
});

describe("email addresses", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  it("accepts ordinary addresses and refuses ones that could add recipients to a reply", () => {
    const base = { service_id: "x", date: TUESDAY, time: "15:00", customer_name: "Ada", student_details: "Me" };
    expect(validateBooking({ ...base, customer_email: "First.Last+lessons@mail.example.co.uk" }).errors.customer_email).toBeUndefined();
    for (const email of ["a@b.co?cc=attacker%40evil.com&subject=hi", "a@b.co#x", "a%40b@c.co", "a@b", "a b@c.co"]) {
      expect(validateBooking({ ...base, customer_email: email }).errors.customer_email).toBeDefined();
    }
  });

  it("encodes stored addresses in the owner's email links", async () => {
    const rt = runtime();
    await seedBookings(rt, 1, () => ({ status: "new", starts_at: TUESDAY_3PM, customer_email: "a@b.co?cc=x%40evil.com" }));
    rt.setUser(OWNER);
    const inbox = await (await get(app, rt, "/studio")).text();
    expect(inbox).toContain('href="mailto:a@b.co%3Fcc%3Dx%2540evil.com"');
    expect(inbox).not.toContain("mailto:a@b.co?cc");
  });
});

describe("form posts to owner pages", () => {
  const app = createApp({ demoMode: false, now: () => NOW });

  function ownerPost(rt: Runtime, pathname: string, headers: Record<string, string>) {
    return app.fetch(new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "status=confirmed&show=new" }), rt.ctx) as Promise<Response>;
  }

  it("need to come from the studio's own pages", async () => {
    const rt = runtime();
    await seedBookings(rt, 1, () => ({ status: "new", starts_at: TUESDAY_3PM }));
    const id = requests(rt)[0]!.id;
    rt.setUser(OWNER);
    const path = `/studio/bookings/${id}/status`;
    const refused: Array<Record<string, string>> = [{}, { origin: "null" }, { origin: "https://other-app.apps.userland.fun" }, { "sec-fetch-site": "same-site" }];
    for (const headers of refused) {
      expect((await ownerPost(rt, path, headers)).status).toBe(403);
    }
    expect(requests(rt)[0]!.data.status).toBe("new");
    expect((await ownerPost(rt, path, { "sec-fetch-site": "same-origin" })).status).toBe(303);
    expect(requests(rt)[0]!.data.status).toBe("confirmed");
  });

  it("still take public booking requests from browsers that send no Origin", async () => {
    const rt = runtime();
    await addLessons(rt);
    const slot = await openTime(app, rt);
    const response = await app.fetch(new Request(`${ORIGIN}/book`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...slot, ...request({}) }).toString() }), rt.ctx);
    expect(response.status).toBe(303);
  });
});

describe("confirmation pages", () => {
  it("ask search engines not to list them", async () => {
    const app = createApp({ demoMode: false, now: () => NOW });
    const rt = runtime();
    await addLessons(rt);
    const location = (await book(app, rt, request({}))).headers.get("location")!;
    expect(await (await get(app, rt, location)).text()).toContain('<meta name="robots" content="noindex,follow">');
    expect(await (await get(app, rt, "/")).text()).not.toContain("noindex");
  });
});

describe("studio time", () => {
  it("converts studio wall-clock times across daylight saving time", () => {
    expect(studioTimeToDate("2026-10-01", "15:00").toISOString()).toBe("2026-10-01T22:00:00.000Z");
    expect(studioTimeToDate("2026-11-02", "15:00").toISOString()).toBe("2026-11-02T23:00:00.000Z");
  });
});

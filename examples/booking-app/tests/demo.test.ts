// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you remove demo mode (see README.md).
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { createApp, validateBooking } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { sweepExpiredRows } from "../server/demo.js";
import { NOW, ORIGIN, book, get, logged, openTime, post, rows, runtime, type Runtime } from "./helpers.js";

function keyFrom(location: string | null) {
  return new URL(location!, ORIGIN).searchParams.get("v");
}

describe("public booking flow in the demo", () => {
  const app = createApp({ demoMode: true, now: () => NOW });

  it("lists lessons and marks demo pages noindex with a link to the example page", async () => {
    const rt = runtime();
    const response = await get(app, rt, "/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Piano lesson");
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain('href="https://userland.fun/examples/booking-app/"');
    expect(rows(rt, "bookings")).toHaveLength(0); // Viewing pages never writes data.
  });

  it("takes a request and shows a confirmation", async () => {
    const rt = runtime();
    const response = await book(app, rt, { customer_name: "Ada Lovelace" });
    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/booked\?ref=WH-[A-Z0-9]{6}&v=[A-Za-z0-9_-]{22}$/u);

    const confirmation = await (await get(app, rt, location)).text();
    expect(confirmation).toContain("Thank you, Ada.");
    expect(confirmation).toContain("a•••@example.com");
    expect(confirmation).not.toContain("ada@example.com");

    // The activity log gets ids only, never contact details.
    const [entry] = logged(rt, "booking requested");
    expect(entry!.metadata).toMatchObject({ booking_id: rows(rt, "bookings")[0]!.id });
    expect(JSON.stringify(entry!.metadata)).not.toContain("example.com");
  });

  it("validates input and escapes what visitors type", async () => {
    const rt = runtime();
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

    const created = await book(app, rt, { customer_name: '<script>alert("hi")</script>' });
    const inbox = await (await get(app, rt, `/studio?v=${keyFrom(created.headers.get("location"))}`)).text();
    expect(inbox).not.toContain("<script>alert");
    expect(inbox).toContain("&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;");
  });

  it("quietly drops requests that fill in the hidden honeypot field", async () => {
    const rt = runtime();
    const response = await book(app, rt, { customer_name: "Bot", company: "Spam Inc" });
    expect(response.status).toBe(200);
    expect(rows(rt, "bookings")).toHaveLength(0);
  });

  it("does not hand out the same time twice", async () => {
    const rt = runtime();
    const first = await book(app, rt, { customer_name: "First" });
    const key = keyFrom(first.headers.get("location"));
    const firstBooking = rows(rt, "bookings").find((row) => row.data.customer_name === "First")!;
    expect(firstBooking.data.starts_at).toBe("2026-09-29T22:00:00.000Z");

    const again = await post(app, rt, `/book?v=${key}`, {
      service_id: String(firstBooking.data.service_id),
      date: "2026-09-29",
      time: "15:00",
      customer_name: "Second",
      customer_email: "b@example.com",
      student_details: "Me"
    });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("that time was just taken");
  });

  it("rejects form posts from other sites", async () => {
    const rt = runtime();
    const slot = await openTime(app, rt);
    const response = await post(app, rt, "/book", { ...slot, customer_name: "Ada", customer_email: "a@example.com", student_details: "Me" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(rows(rt, "bookings")).toHaveLength(0);
  });
});

describe("demo privacy", () => {
  const app = createApp({ demoMode: true, now: () => NOW });

  it("never shows one visitor's requests to another visitor", async () => {
    const rt = runtime();
    const alice = keyFrom((await book(app, rt, { customer_name: "Alice Private", customer_email: "alice@example.com" })).headers.get("location"));
    const bob = keyFrom((await book(app, rt, { customer_name: "Bob Private", customer_email: "bob@example.com" })).headers.get("location"));
    expect(alice).not.toBe(bob);

    const aliceInbox = await (await get(app, rt, `/studio?show=all&v=${alice}`)).text();
    const bobInbox = await (await get(app, rt, `/studio?show=all&v=${bob}`)).text();
    const newVisitorInbox = await (await get(app, rt, "/studio?show=all")).text();

    expect(aliceInbox).toContain("Alice Private");
    expect(aliceInbox).not.toContain("Bob Private");
    expect(bobInbox).toContain("Bob Private");
    expect(bobInbox).not.toContain("Alice Private");
    expect(newVisitorInbox).not.toContain("Alice Private");
    expect(newVisitorInbox).not.toContain("Bob Private");
    expect(newVisitorInbox).toContain("Priya Raman"); // Sample bookings.

    // A confirmation link only works with the visitor's own key.
    const aliceRef = rows(rt, "bookings").find((row) => row.data.customer_name === "Alice Private")!.data.ref;
    expect((await get(app, rt, `/booked?ref=${aliceRef}&v=${bob}`)).status).toBe(404);
    expect((await get(app, rt, `/booked?ref=${aliceRef}`)).status).toBe(404);
  });

  it("keeps status changes and lesson edits inside the visitor's own copy", async () => {
    const rt = runtime();
    const inbox = await (await get(app, rt, "/studio")).text();
    const sampleId = inbox.match(/id="booking-(sample-booking-\d+)"/u)![1];

    const confirmed = await post(app, rt, `/studio/bookings/${sampleId}/status`, { status: "confirmed", show: "new" });
    expect(confirmed.status).toBe(303);
    const key = keyFrom(confirmed.headers.get("location"));
    expect(key).toBeTruthy();

    const mine = await (await get(app, rt, `/studio?show=confirmed&v=${key}`)).text();
    expect(mine).toContain("Priya Raman");
    const someoneElse = await (await get(app, rt, "/studio?show=confirmed")).text();
    expect(someoneElse).not.toContain("Priya Raman");

    const rename = await post(app, rt, `/studio/lessons/sample-service-2?v=${key}`, { name: "Piano for grown-ups", summary: "", duration_minutes: "45", price: "65", active: "yes" });
    expect(rename.status).toBe(303);
    expect(await (await get(app, rt, `/?v=${key}`)).text()).toContain("Piano for grown-ups");
    expect(await (await get(app, rt, "/")).text()).not.toContain("Piano for grown-ups");
  });

  it("copies samples once, on the first owner-side change, without duplicating them", async () => {
    const rt = runtime();
    const key = keyFrom((await book(app, rt, { customer_name: "Casey Visitor" })).headers.get("location"));
    expect(rows(rt, "bookings")).toHaveLength(1); // Booking alone does not copy the samples.

    const inbox = await (await get(app, rt, `/studio?show=all&v=${key}`)).text();
    expect(inbox.match(/<h2>Priya Raman<\/h2>/gu)).toHaveLength(1);
    const sampleId = inbox.match(/id="booking-(sample-booking-\d+)"/u)![1];

    await post(app, rt, `/studio/bookings/${sampleId}/status?v=${key}`, { status: "confirmed", show: "all" });
    await post(app, rt, `/studio/bookings/${sampleId}/status?v=${key}`, { status: "declined", show: "all" });
    expect(rows(rt, "bookings")).toHaveLength(6);

    const after = await (await get(app, rt, `/studio?show=all&v=${key}`)).text();
    expect(after.match(/<h2>Priya Raman<\/h2>/gu)).toHaveLength(1);
    expect(after.match(/<h2>Casey Visitor<\/h2>/gu)).toHaveLength(1);
  });
});

describe("demo clean-up", () => {
  const app = createApp({ demoMode: true, now: () => NOW });
  const HOUR = 60 * 60 * 1000;
  const at = (offsetHours: number) => new Date(NOW.getTime() + offsetHours * HOUR).toISOString();

  async function addBookings(rt: Runtime, count: number, fields: Record<string, unknown>) {
    const bookings = rt.ctx.data.collection("bookings");
    for (let index = 0; index < count; index += 1) {
      await bookings.create({ ref: `WH-T${String(rows(rt, "bookings").length).padStart(5, "0")}`, status: "new", starts_at: at(48), ends_at: at(49), customer_name: "Old Visitor", history: [], ...fields });
    }
  }

  it("finds expired rows even when more than 100 newer rows exist", async () => {
    const rt = runtime();
    // Expired rows are written first, so the platform's default newest-first
    // order would put them after the 120 fresh rows.
    await addBookings(rt, 30, { demo_key: "expiredvisitorkey00000", demo_expires_at: at(-2) });
    await addBookings(rt, 120, { demo_key: "freshvisitorkey0000000", demo_expires_at: at(20) });
    await addBookings(rt, 3, { demo_key: "" }); // A real studio's rows never expire.
    const expiredLeft = () => rows(rt, "bookings").filter((row) => row.data.demo_key === "expiredvisitorkey00000").length;

    expect(await sweepExpiredRows(rt.ctx.data.collection("bookings"), NOW)).toBe(20);
    expect(expiredLeft()).toBe(10);

    // Every demo write sweeps another batch.
    await book(app, rt, { customer_name: "Next Visitor" });
    expect(expiredLeft()).toBe(0);
    expect(rows(rt, "bookings").filter((row) => row.data.demo_key === "freshvisitorkey0000000")).toHaveLength(120);
    expect(rows(rt, "bookings").filter((row) => row.data.demo_key === "")).toHaveLength(3);
  });

  it("gives every visitor row an expiry a day ahead and sweeps lessons too", async () => {
    const rt = runtime();
    await rt.ctx.data.collection("services").create({ name: "Old lesson", duration_minutes: 30, price_cents: 100, sort_order: 1, active: true, demo_key: "expiredvisitorkey00000", demo_expires_at: at(-1) });
    await book(app, rt, { customer_name: "Dana Visitor" });
    expect(rows(rt, "services")).toHaveLength(0);
    expect(rows(rt, "bookings")[0]!.data.demo_expires_at).toBe(at(24));
  });
});

describe("double-clicked owner buttons in the demo", () => {
  const app = createApp({ demoMode: true, now: () => NOW });

  it("shows one copy of each sample booking when two changes arrive together", async () => {
    const rt = runtime();
    const key = keyFrom((await book(app, rt, { customer_name: "Casey Visitor" })).headers.get("location"));
    const responses = await Promise.all([
      post(app, rt, `/studio/bookings/sample-booking-1/status?v=${key}`, { status: "confirmed", show: "new" }),
      post(app, rt, `/studio/bookings/sample-booking-2/status?v=${key}`, { status: "confirmed", show: "new" })
    ]);
    expect(responses.map((response) => response.status)).toEqual([303, 303]);
    // Both requests copied the samples, which is the case being tested.
    expect(rows(rt, "bookings").filter((row) => row.data.demo_copy_of)).toHaveLength(10);

    const all = await (await get(app, rt, `/studio?show=all&v=${key}`)).text();
    for (const name of ["Priya Raman", "Tom Becker", "Hannah Silva", "Daniel Moreau", "Grace Liu", "Casey Visitor"]) {
      expect(all.match(new RegExp(`<h2>${name}</h2>`, "gu"))).toHaveLength(1);
    }
    const confirmed = await (await get(app, rt, `/studio?show=confirmed&v=${key}`)).text();
    expect(confirmed).toContain("<h2>Priya Raman</h2>");
    expect(confirmed).toContain("<h2>Tom Becker</h2>");
  });

  it("shows one copy of each sample lesson when two edits arrive together", async () => {
    const rt = runtime();
    const key = keyFrom((await book(app, rt, { customer_name: "Casey Visitor" })).headers.get("location"));
    const edit = { summary: "", duration_minutes: "45", price: "65", active: "yes" };
    const responses = await Promise.all([
      post(app, rt, `/studio/lessons/sample-service-2?v=${key}`, { ...edit, name: "Piano for grown-ups" }),
      post(app, rt, `/studio/lessons/sample-service-3?v=${key}`, { ...edit, name: "Singing for grown-ups" })
    ]);
    expect(responses.map((response) => response.status)).toEqual([303, 303]);
    const page = await (await get(app, rt, `/studio/lessons?v=${key}`)).text();
    const names = [...page.matchAll(/name="name"[^>]*value="([^"]+)"/gu)].map((match) => match[1]).filter((name) => name !== "");
    expect(names.sort()).toEqual(["Extended lesson", "First lesson", "Piano for grown-ups", "Singing for grown-ups"]);
  });
});

describe("demo address", () => {
  const app = createApp({ now: () => NOW });

  it("turns demo mode on only at the demo address", async () => {
    const rt = runtime();
    expect((await get(app, rt, "/studio")).status).toBe(200);

    const otherApp = await get(app, rt, "/studio", "https://1abc.apps.userland.fun");
    expect(otherApp.status).toBe(303);
    expect(otherApp.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fstudio");

    const customDomain = await (await get(app, rt, "/", "https://lessons.example.com")).text();
    expect(customDomain).not.toContain("noindex");
    expect(customDomain).not.toContain("Built with Userland");
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { createApp } from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { COUNT_LIMIT, DELETE_BATCH, PAGE_SIZE, REPAIR_BATCH, REQUEST_LIMITS, validateLead } from "../server/leads.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { mailtoHref } from "../server/views.js";
import { EXAMPLE_DIR, ORIGIN, OWNER, at, get, makeCtx, post, request } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Save leads straight to the data collections, as if they arrived earlier.
 * `via` is "form" (the public form) or "owner"; `older` saves them the way an
 * earlier version of this app did, without received_at or via.
 */
async function seedLeads(ctx: ReturnType<typeof makeCtx>, count: number, { stage = "new", minutesApart = 1, from = Date.now(), via = "form", older = false, prefix = "Seeded" } = {}) {
  for (let index = 0; index < count; index += 1) {
    await ctx.data.collection("leads").create({
      name: `${prefix} ${String(index).padStart(3, "0")}`,
      email: `seeded${index}@example.com`,
      phone: "",
      project: "kitchen",
      budget: "not_sure",
      details: "Seeded lead.",
      source: "website",
      stage,
      follow_up_on: "",
      ...(older ? {} : { received_at: new Date(from - index * minutesApart * 60_000).toISOString(), via })
    });
  }
}

/** Send `count` form requests at the same moment, each from a different address. */
async function burst(app: any, ctx: ReturnType<typeof makeCtx>, count: number, label = "burst") {
  const responses = await Promise.all(Array.from({ length: count }, (_, index) => post(app, ctx, "/estimate", { ...request, email: `${label}${index}@example.com` })));
  return responses.map((response) => response.status);
}

/** A field's type in the manifest: "string", "enum", and so on. */
function fieldType(spec: unknown) {
  return typeof spec === "string" ? spec : (spec as { type: string }).type;
}

describe("the manifest", () => {
  // Userland won't make a release live if it removes a field, or changes a
  // field's type, that the published app already has. These are the fields
  // earlier releases of this example published (the demo's are checked in
  // tests/demo.test.ts).
  it("keeps every field earlier releases published, with the same type", () => {
    const published: Record<string, Record<string, string>> = {
      leads: { name: "string", email: "string", phone: "string", project: "enum", budget: "enum", timeline: "enum", details: "string", stage: "enum", source: "enum", follow_up_on: "string" },
      activity: { lead_id: "string", lead_name: "string", kind: "enum", stage: "enum", body: "string" }
    };
    const collections = (readExampleManifest(EXAMPLE_DIR) as any).resources.data.collections;
    for (const [collection, fields] of Object.entries(published)) {
      for (const [field, type] of Object.entries(fields)) {
        expect(fieldType(collections[collection].fields[field]), `${collection}.${field}`).toBe(type);
      }
    }
  });
});

describe("public estimate form", () => {
  it("renders the form without demo notices when demo mode is off", async () => {
    const app = createApp();
    const response = await get(app, makeCtx(), "/");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('action="/estimate"');
    expect(body).toContain('name="website"');
    expect(body).not.toContain('name="robots"');
    expect(body).not.toContain("Demo app");
    expect(body).toContain("We only use your details to reply about this project.");
  });

  it("saves a valid request as a new lead with a history entry", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const response = await post(app, ctx, "/estimate", request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/thanks");
    expect(ctx.state.leads).toHaveLength(1);
    expect(ctx.state.leads[0]).toMatchObject({ name: "Jordan Pike", email: "jordan.pike@example.com", stage: "new", source: "website" });
    expect(ctx.state.leads[0]!.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ctx.state.leads[0]!.via).toBe("form");
    expect(ctx.state.activity[0]).toMatchObject({ lead_id: ctx.state.leads[0]!.id, kind: "received" });
    // App events never carry the visitor's contact details.
    expect(JSON.stringify(ctx.log.info.mock.calls)).not.toContain("jordan");
  });

  it("shows field errors and escapes what the visitor typed", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const response = await post(app, ctx, "/estimate", { ...request, name: '<script>alert("x")</script>', email: "not-an-email", project: "castle" });
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(body).toContain("Enter an email address like name@example.com.");
    expect(body).toContain("Choose the kind of project.");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>alert");
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("drops submissions that fill the hidden honeypot field", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const response = await post(app, ctx, "/estimate", { ...request, website: "http://spam.example" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/thanks");
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("rejects form posts from other sites and oversized fields", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const crossSite = await post(app, ctx, "/estimate", request, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    const tooLong = await post(app, ctx, "/estimate", { ...request, details: "x".repeat(1200) });
    expect(tooLong.status).toBe(422);
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("accepts a request with no Origin header, like the README's curl check", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const response = await app.fetch(
      new Request(`${ORIGIN}/estimate`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(request).toString() }),
      ctx
    );
    expect(response.status).toBe(303);
    expect(ctx.state.leads).toHaveLength(1);
  });
});

describe("email addresses", () => {
  it("refuses addresses that could add parts to a mailto: link", () => {
    for (const email of ["victim@example.com?bcc=attacker%40evil.example", "a&b@example.com", "a%40b@example.com", "a#b@example.com", "a@b", "a@-b.com"]) {
      expect(validateLead({ ...request, email }, "public").errors.email, email).toBe("Enter an email address like name@example.com.");
    }
    for (const email of ["jordan.pike@example.com", "o'brien+quotes@mail.example.co.uk"]) {
      expect(validateLead({ ...request, email }, "public").errors.email, email).toBeUndefined();
    }
  });

  it("links to the saved address with everything but the @ encoded", async () => {
    expect(mailtoHref("a?bcc=x@example.com")).toBe("mailto:a%3Fbcc%3Dx@example.com");
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    await post(app, ctx, "/estimate", { ...request, email: "o'brien+quotes@example.com" });
    const detail = await (await get(app, ctx, `/admin/leads/${ctx.state.leads[0]!.id}`)).text();
    expect(detail).toContain('href="mailto:o&#39;brien%2Bquotes@example.com"');
  });
});

describe("form size", () => {
  it("refuses a body over 16 KiB even without Content-Length", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const chunk = new TextEncoder().encode(`details=${"x".repeat(4096)}&`);
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        sent += 1;
        if (sent > 10) controller.close();
        else controller.enqueue(chunk);
      }
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/estimate`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body, duplex: "half" } as RequestInit),
      ctx
    );
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.status).toBe(413);
    // The server stopped reading once it passed the limit.
    expect(sent).toBeLessThan(10);
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("refuses a body whose Content-Length is over the limit without reading it", async () => {
    const response = await post(createApp(), makeCtx(), "/estimate", request, { "content-length": String(64 * 1024) });
    expect(response.status).toBe(413);
  });
});

describe("limits on the public form", () => {
  it("takes a few requests per email address in 24 hours", async () => {
    const app = createApp();
    const ctx = makeCtx();
    for (let index = 0; index < REQUEST_LIMITS.perEmailPerDay; index += 1) {
      expect((await post(app, ctx, "/estimate", request)).status).toBe(303);
    }
    const refused = await post(app, ctx, "/estimate", { ...request, email: "JORDAN.PIKE@example.com" });
    expect(refused.status).toBe(429);
    const text = await refused.text();
    expect(text).toContain("We already have your request");
    expect(text).toContain("(555) 010-0140");
    expect(ctx.log.warn).toHaveBeenCalledWith("request form limit reached", { scope: "email" });
    expect(ctx.state.leads).toHaveLength(REQUEST_LIMITS.perEmailPerDay);
    expect(ctx.state.activity).toHaveLength(REQUEST_LIMITS.perEmailPerDay);

    // Another address still gets through, and the same one does a day later.
    expect((await post(app, ctx, "/estimate", { ...request, email: "someone.else@example.com" })).status).toBe(303);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 3_600_000 + 1_000);
    expect((await post(app, ctx, "/estimate", request)).status).toBe(303);
  });

  it("never keeps more than perEmailPerDay requests from one address, even when they arrive together", async () => {
    for (const jitterMs of [0, 5]) {
      const app = createApp();
      const ctx = makeCtx();
      ctx.faults.jitterMs = jitterMs;
      const statuses = await Promise.all(Array.from({ length: 12 }, () => post(app, ctx, "/estimate", request).then((response) => response.status)));
      expect(statuses.every((status) => status === 303 || status === 429)).toBe(true);
      const kept = statuses.filter((status) => status === 303).length;
      expect(ctx.state.leads.length).toBeLessThanOrEqual(REQUEST_LIMITS.perEmailPerDay);
      expect(ctx.state.leads).toHaveLength(kept);
      // Every lead that stayed has its history entry; refused ones left nothing.
      expect(ctx.state.activity).toHaveLength(kept);
    }
  });

  it("pauses the form after perHour requests in an hour, then opens again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-01T12:00:00Z"));
    const app = createApp();
    const ctx = makeCtx();
    for (let index = 0; index < REQUEST_LIMITS.perHour; index += 1) {
      expect((await post(app, ctx, "/estimate", { ...request, email: `person${index}@example.com` })).status).toBe(303);
    }
    const busy = await post(app, ctx, "/estimate", { ...request, email: "one.more@example.com" });
    expect(busy.status).toBe(429);
    expect(await busy.text()).toContain("We&#39;re getting a lot of requests");
    expect(ctx.state.leads).toHaveLength(REQUEST_LIMITS.perHour);

    // The owner can still add leads by hand.
    ctx.setUser(OWNER);
    expect((await post(app, ctx, "/admin/leads", { ...request, source: "phone" })).status).toBe(303);

    vi.setSystemTime(Date.parse("2026-09-01T13:01:00Z"));
    expect((await post(app, ctx, "/estimate", { ...request, email: "one.more@example.com" })).status).toBe(303);
  });

  it("pauses the form after perDay requests in a day", async () => {
    const app = createApp();
    const ctx = makeCtx();
    // Spread over the last day, so no single hour is over perHour.
    await seedLeads(ctx, REQUEST_LIMITS.perDay, { minutesApart: 20 });
    const busy = await post(app, ctx, "/estimate", request);
    expect(busy.status).toBe(429);
    expect(ctx.state.leads).toHaveLength(REQUEST_LIMITS.perDay);
  });

  it("keeps the form open however many leads the owner adds", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    for (let index = 0; index < REQUEST_LIMITS.perHour + 5; index += 1) {
      expect((await post(app, ctx, "/admin/leads", { ...request, email: `phone${index}@example.com`, source: "phone" })).status).toBe(303);
    }
    // A busy day of phone leads, more than the form's daily limit.
    await seedLeads(ctx, REQUEST_LIMITS.perDay + 10, { via: "owner", minutesApart: 10, prefix: "Phone" });
    expect(ctx.state.leads.every((lead) => lead.via === "owner")).toBe(true);
    ctx.setUser(null);
    expect((await post(app, ctx, "/estimate", request)).status).toBe(303);
  });

  it("never keeps more than perHour requests when a burst arrives at once", async () => {
    for (const jitterMs of [0, 5]) {
      const app = createApp();
      const ctx = makeCtx();
      ctx.faults.jitterMs = jitterMs;
      const statuses = await burst(app, ctx, 300);
      expect(statuses.every((status) => status === 303 || status === 429)).toBe(true);
      const kept = statuses.filter((status) => status === 303).length;
      expect(ctx.state.leads.length).toBeLessThanOrEqual(REQUEST_LIMITS.perHour);
      expect(ctx.state.leads).toHaveLength(kept);
      expect(ctx.state.activity).toHaveLength(kept);

      // Afterwards the form takes requests one at a time up to exactly perHour.
      ctx.faults.jitterMs = 0;
      for (let index = 0; index < REQUEST_LIMITS.perHour + 2; index += 1) {
        await post(app, ctx, "/estimate", { ...request, email: `after${index}@example.com` });
      }
      expect(ctx.state.leads).toHaveLength(REQUEST_LIMITS.perHour);
      expect(ctx.state.activity).toHaveLength(REQUEST_LIMITS.perHour);
    }
  });

  it("never passes perHour or perDay when a burst lands near the limit", async () => {
    const nearHour = makeCtx();
    nearHour.faults.jitterMs = 5;
    await seedLeads(nearHour, REQUEST_LIMITS.perHour - 2, { minutesApart: 0 });
    await burst(createApp(), nearHour, 30);
    expect(nearHour.state.leads.length).toBeLessThanOrEqual(REQUEST_LIMITS.perHour);
    expect(nearHour.state.leads.length).toBeGreaterThanOrEqual(REQUEST_LIMITS.perHour - 2);

    const nearDay = makeCtx();
    nearDay.faults.jitterMs = 5;
    // Two hours back and older, so the hourly limit has room.
    await seedLeads(nearDay, REQUEST_LIMITS.perDay - 2, { minutesApart: 15, from: Date.now() - 2 * 3_600_000 });
    await burst(createApp(), nearDay, 30);
    expect(nearDay.state.leads.length).toBeLessThanOrEqual(REQUEST_LIMITS.perDay);
    expect(nearDay.state.activity.length).toBe(nearDay.state.leads.length - (REQUEST_LIMITS.perDay - 2));
  });

  it("asks visitors to call when the app is out of data rows, and tells the owner how to make room", async () => {
    const app = createApp();
    const ctx = makeCtx();
    ctx.faults.quotaFull = true;
    const response = await post(app, ctx, "/estimate", request);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("We can&#39;t take requests online right now");
    expect(text).toContain("(555) 010-0140");
    expect(ctx.log.error).toHaveBeenCalledWith("data row limit reached", { path: "/estimate", demo: false });

    ctx.setUser(OWNER);
    const owner = await post(app, ctx, "/admin/leads", { ...request, source: "phone" });
    expect(owner.status).toBe(503);
    expect(await owner.text()).toContain("Delete old or spam leads to make room");
  });
});

describe("owner routes with demo mode off", () => {
  it("send signed-out visitors to the sign-in page and save nothing", async () => {
    const app = createApp();
    const ctx = makeCtx();
    const board = await get(app, ctx, "/admin?stage=new");
    expect(board.status).toBe(303);
    expect(board.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin%3Fstage%3Dnew");

    const detail = await get(app, ctx, "/admin/leads/leads_1");
    expect(detail.status).toBe(303);

    const create = await post(app, ctx, "/admin/leads", { ...request, source: "phone" });
    expect(create.status).toBe(401);
    expect(ctx.state.leads).toHaveLength(0);
  });

  it("refuse signed-in app users without the owner role", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: { id: "u_2", email: "helper@example.com", roles: [] } });
    const response = await get(app, ctx, "/admin");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Owner access only");
  });

  it("let the owner add a lead, move it through stages, and add notes", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });

    const created = await post(app, ctx, "/admin/leads", { ...request, source: "referral", timeline: "" });
    expect(created.status).toBe(303);
    const leadId = ctx.state.leads[0]!.id;
    expect(created.headers.get("location")).toBe(`/admin/leads/${leadId}?saved=created`);
    expect(ctx.state.activity[0]).toMatchObject({ kind: "added" });

    const updated = await post(app, ctx, `/admin/leads/${leadId}/stage`, { stage: "site_visit", follow_up_on: "2026-10-02" });
    expect(updated.status).toBe(303);
    expect(ctx.state.leads[0]).toMatchObject({ stage: "site_visit", follow_up_on: "2026-10-02" });

    const badDate = await post(app, ctx, `/admin/leads/${leadId}/stage`, { stage: "quoted", follow_up_on: "2026-02-31" });
    expect(badDate.status).toBe(422);
    expect(ctx.state.leads[0]!.stage).toBe("site_visit");

    const note = await post(app, ctx, `/admin/leads/${leadId}/notes`, { body: "Measured <b>8x10</b>. Needs a vent fan." });
    expect(note.status).toBe(303);
    expect(ctx.state.activity.map((entry) => entry.kind)).toEqual(["added", "stage", "follow_up", "note"]);

    const detail = await (await get(app, ctx, `/admin/leads/${leadId}`)).text();
    expect(detail).toContain("Measured &lt;b&gt;8x10&lt;/b&gt;");
    expect(detail).toContain('name="robots" content="noindex,nofollow"');
    expect(detail).toContain('href="/_userland/auth/logout"');

    const board = await (await get(app, ctx, "/admin?stage=site_visit")).text();
    expect(board).toMatch(/class="lead-link"[^>]*>Jordan Pike</);
    const quoted = await (await get(app, ctx, "/admin?stage=quoted")).text();
    expect(quoted).not.toContain('class="lead-link"');
    expect(quoted).toContain("No quoted leads right now.");
  });

  it("refuse owner form posts from other apps on apps.userland.fun or with no origin at all", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    const fields = { ...request, source: "phone" };
    const refused: Array<Record<string, string>> = [
      { origin: "https://other-app.apps.userland.fun" },
      { origin: "null" },
      { origin: "", "sec-fetch-site": "same-site" },
      { origin: "", referer: "https://other-app.apps.userland.fun/page" },
      { origin: "" }
    ];
    for (const headers of refused) {
      const cleaned = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== ""));
      const response = await app.fetch(
        new Request(`${ORIGIN}/admin/leads`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...cleaned }, body: new URLSearchParams(fields).toString() }),
        ctx
      );
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    expect((await post(app, ctx, "/estimate", request, { origin: "https://other-app.apps.userland.fun" })).status).toBe(403);
    expect(ctx.state.leads).toHaveLength(0);

    // Same-origin posts pass on Origin, Sec-Fetch-Site, or Referer alone.
    const allowed: Array<Record<string, string>> = [{ origin: ORIGIN }, { "sec-fetch-site": "same-origin" }, { referer: `${ORIGIN}/admin/leads/new` }];
    for (const headers of allowed) {
      const response = await app.fetch(
        new Request(`${ORIGIN}/admin/leads`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() }),
        ctx
      );
      expect(response.status, JSON.stringify(headers)).toBe(303);
    }
  });
});

describe("deleting a lead", () => {
  it("asks for confirmation, then removes the lead and its history", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    await post(app, ctx, "/estimate", request);
    await post(app, ctx, "/estimate", { ...request, name: "Keep Me", email: "keep@example.com" });
    const [spam] = ctx.state.leads;
    await post(app, ctx, `/admin/leads/${spam!.id}/notes`, { body: "Looks like spam." });

    const unconfirmed = await post(app, ctx, `/admin/leads/${spam!.id}/delete`, {});
    expect(unconfirmed.status).toBe(422);
    expect(await unconfirmed.text()).toContain("Tick the box to confirm");
    expect(ctx.state.leads).toHaveLength(2);

    const deleted = await post(app, ctx, `/admin/leads/${spam!.id}/delete`, { confirm: "yes" });
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get("location")).toBe("/admin?saved=deleted");
    expect(ctx.state.leads.map((lead) => lead.name)).toEqual(["Keep Me"]);
    expect(ctx.state.activity.every((entry) => entry.lead_id !== spam!.id)).toBe(true);
    expect(ctx.state.activity).toHaveLength(1);

    const board = await (await get(app, ctx, "/admin?saved=deleted")).text();
    expect(board).toContain("Lead deleted.");
    expect(board).not.toContain("Jordan Pike");
    expect((await get(app, ctx, `/admin/leads/${spam!.id}`)).status).toBe(404);
  });

  it("removes a long history over more than one request and keeps the lead until it's gone", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    await post(app, ctx, "/admin/leads", { ...request, source: "phone" });
    const leadId = ctx.state.leads[0]!.id;
    for (let index = 0; index < DELETE_BATCH + 4; index += 1) {
      await ctx.data.collection("activity").create({ lead_id: leadId, lead_name: "Jordan Pike", kind: "note", body: `Note ${index}` });
    }
    const first = await post(app, ctx, `/admin/leads/${leadId}/delete`, { confirm: "yes" });
    expect(first.headers.get("location")).toBe(`/admin/leads/${leadId}?saved=deleting`);
    expect(ctx.state.leads).toHaveLength(1);
    expect(await (await get(app, ctx, `/admin/leads/${leadId}?saved=deleting`)).text()).toContain("Press Delete lead again to finish.");

    const second = await post(app, ctx, `/admin/leads/${leadId}/delete`, { confirm: "yes" });
    expect(second.headers.get("location")).toBe("/admin?saved=deleted");
    expect(ctx.state.leads).toHaveLength(0);
    expect(ctx.state.activity).toHaveLength(0);
  });

  it("frees rows so the form works again after spam fills the day's limit", async () => {
    const app = createApp();
    const ctx = makeCtx();
    for (let index = 0; index < REQUEST_LIMITS.perHour; index += 1) {
      await post(app, ctx, "/estimate", { ...request, email: `bot${index}@example.com` });
    }
    expect((await post(app, ctx, "/estimate", request)).status).toBe(429);
    ctx.setUser(OWNER);
    for (const lead of [...ctx.state.leads]) {
      expect((await post(app, ctx, `/admin/leads/${lead.id}/delete`, { confirm: "yes" })).status).toBe(303);
    }
    expect(ctx.state.leads).toHaveLength(0);
    expect((await post(app, ctx, "/estimate", request)).status).toBe(303);
  });
});

describe("lead board pages", () => {
  it("pages through every lead, newest first, and counts past the first page", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    const total = COUNT_LIMIT + 20;
    await seedLeads(ctx, total);

    const seen: string[] = [];
    let next = "/admin";
    for (let page = 0; page < 5 && next; page += 1) {
      const body = await (await get(app, ctx, next)).text();
      seen.push(...[...body.matchAll(/class="lead-link"[^>]*>(Seeded \d+)</g)].map((match) => match[1]!));
      const older = body.match(/href="(\/admin\?after=[^"]+)">Older leads</);
      next = older ? older[1]!.replaceAll("&amp;", "&") : "";
      if (page === 0) {
        expect(body).toContain(`All<span class="tab-count">${COUNT_LIMIT}+</span>`);
        expect(body).toContain(`New<span class="tab-count">${COUNT_LIMIT}+</span>`);
        expect(body).toContain(`${COUNT_LIMIT}+ open · ${COUNT_LIMIT}+ total`);
        expect(body).not.toContain("Newest leads");
      } else {
        expect(body).toContain("Newest leads");
      }
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe("Seeded 000");
    expect(seen.at(-1)).toBe(`Seeded ${String(total - 1).padStart(3, "0")}`);
    expect(Math.ceil(total / PAGE_SIZE)).toBe(3);
  });

  it("pages within one stage and shows exact counts under the limit", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    await seedLeads(ctx, PAGE_SIZE + 5, { stage: "quoted" });
    await seedLeads(ctx, 3, { stage: "won" });
    const first = await (await get(app, ctx, "/admin?stage=quoted")).text();
    expect(first.match(/class="lead-link"/g)).toHaveLength(PAGE_SIZE);
    expect(first).toContain(`Quoted<span class="tab-count">${PAGE_SIZE + 5}</span>`);
    expect(first).toContain(`Won<span class="tab-count">3</span>`);
    const older = first.match(/href="(\/admin\?stage=quoted&amp;after=[^"]+)">Older leads</);
    expect(older).not.toBeNull();
    const second = await (await get(app, ctx, older![1]!.replaceAll("&amp;", "&"))).text();
    expect(second.match(/class="lead-link"/g)).toHaveLength(5);
    expect(second).not.toContain("Older leads");
  });

  it("dates leads saved by an earlier version of the app, so they stop crowding out new ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-08-01T12:00:00Z"));
    const app = createApp();
    const ctx = makeCtx();
    const older = REPAIR_BATCH * 2 + 5;
    await seedLeads(ctx, older, { older: true, prefix: "Older" });

    // Older leads don't count toward the form's limits or hide recent requests from them.
    for (let index = 0; index < REQUEST_LIMITS.perHour; index += 1) {
      vi.setSystemTime(Date.parse("2026-09-01T12:00:00Z") + index * 60_000);
      expect((await post(app, ctx, "/estimate", { ...request, name: `Recent ${index}`, email: `recent${index}@example.com` })).status).toBe(303);
    }
    expect((await post(app, ctx, "/estimate", { ...request, email: "one.more@example.com" })).status).toBe(429);

    // Each board visit dates REPAIR_BATCH of them; after that the newest lead is on top.
    ctx.setUser(OWNER);
    const visits = Math.ceil(older / REPAIR_BATCH);
    for (let visit = 0; visit < visits; visit += 1) expect((await get(app, ctx, "/admin")).status).toBe(200);
    expect(ctx.state.leads.every((lead) => typeof lead.received_at === "string")).toBe(true);
    const board = await (await get(app, ctx, "/admin")).text();
    expect(board.match(/class="lead-link"[^>]*>([^<]+)</)![1]).toBe(`Recent ${REQUEST_LIMITS.perHour - 1}`);
  });

  it("recovers from a broken page link", async () => {
    const app = createApp();
    const ctx = makeCtx({ user: OWNER });
    await seedLeads(ctx, 2);
    for (const after of ["!!!", "a".repeat(300)]) {
      const response = await get(app, ctx, `/admin?after=${encodeURIComponent(after)}`);
      expect(response.status, after).toBe(200);
      expect(await response.text()).toContain("Seeded 000");
    }
    // A link past the last page shows an empty page with a way back.
    const past = await (await get(app, ctx, "/admin?after=zzzz")).text();
    expect(past).toContain("No older leads.");
    expect(past).toContain("Newest leads");
  });
});

describe("HEAD requests", () => {
  it("answer every page like GET, without a body", async () => {
    const app = createApp();
    const owner = makeCtx({ user: OWNER });
    const created = await post(app, owner, "/admin/leads", { ...request, source: "phone" });
    const leadPath = new URL(created.headers.get("location")!, ORIGIN).pathname;
    const pages: Array<[string, number]> = [
      ["/", 200],
      ["/thanks", 200],
      ["/admin", 200],
      ["/admin?stage=new", 200],
      ["/admin/leads/new", 200],
      [leadPath, 200],
      ["/missing", 404]
    ];
    for (const [pathname, status] of pages) {
      expect((await expectHeadLikeGet(app, owner, `${ORIGIN}${pathname}`)).status).toBe(status);
    }
  });

  it("send signed-out visitors to sign in, like GET", async () => {
    const response = await expectHeadLikeGet(createApp(), makeCtx(), `${ORIGIN}/admin?stage=new`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin%3Fstage%3Dnew");
  });
});

describe("the published app outside the demo's addresses", () => {
  // server/index.js exports createApp({ demo }), but demo mode only turns on at
  // the public demo's addresses. A copy published anywhere else, before or
  // after removing demo.js, runs the signed-in owner board.
  const copy = at("https://my-plumbing.apps.userland.fun");

  it("requires sign-in for the owner board and saves real leads where the owner sees them", async () => {
    const ctx = makeCtx();
    const home = await (await copy.get(app, ctx, "/")).text();
    expect(home).not.toContain("Demo app");
    expect(home).not.toContain('name="robots"');

    const board = await copy.get(app, ctx, "/admin");
    expect(board.status).toBe(303);
    expect(board.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin");

    const sent = await copy.post(app, ctx, "/estimate", request);
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/thanks");
    expect(ctx.state.leads).toHaveLength(1);
    expect(ctx.state.activity[0]!.demo_visitor ?? "").toBe("");

    ctx.setUser(OWNER);
    const ownerBoard = await (await copy.get(app, ctx, "/admin")).text();
    expect(ownerBoard).toContain("Jordan Pike");
    expect(ownerBoard).not.toContain("Maya Okafor");
  });
});

// ---------------------------------------------------------------------------
// Removing the demo code. Steps 1 to 4 in README.md and server/demo.js.
// ---------------------------------------------------------------------------

/** Step 2: edit server/index.js. Returns the new source. */
function withoutDemoImport(source: string) {
  const kept = source
    .split("\n")
    .filter((line) => !line.startsWith('import { demo } from "./demo.js";'))
    .map((line) => (line === "export default createApp({ demo });" ? "export default createApp();" : line));
  return kept.join("\n");
}

/**
 * Step 3: drop demo_visitor from leads, and demo_visitor, demo_saved_at, and
 * by_demo_visitor from activity.
 */
function withoutDemoFields(manifest: any) {
  delete manifest.resources.data.collections.leads.fields.demo_visitor;
  const activity = manifest.resources.data.collections.activity;
  delete activity.fields.demo_visitor;
  delete activity.fields.demo_saved_at;
  activity.indexes = (activity.indexes ?? []).filter((index: { name: string }) => index.name !== "by_demo_visitor");
  if (activity.indexes.length === 0) delete activity.indexes;
  return manifest;
}

describe("turning demo mode off", () => {
  // Follows steps 1 to 3 on a copy of server/ and the manifest, then checks
  // the public form and the owner board still work.
  async function strippedApp() {
    const source = path.join(EXAMPLE_DIR, "server");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "mini-crm-no-demo-"));
    try {
      for (const name of fs.readdirSync(source)) {
        if (name === "demo.js") continue;
        fs.copyFileSync(path.join(source, name), path.join(target, name));
      }
      // Once demo mode is gone from server/, these edits find nothing to change.
      const edited = withoutDemoImport(fs.readFileSync(path.join(target, "index.js"), "utf8"));
      expect(edited).not.toContain('demo.js"');
      expect(edited.split("\n")).toContain("export default createApp();");
      fs.writeFileSync(path.join(target, "index.js"), edited);
      return (await import(pathToFileURL(path.join(target, "index.js")).href)).default;
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  function strippedManifest() {
    const manifest = withoutDemoFields(readExampleManifest(EXAMPLE_DIR));
    expect(JSON.stringify(manifest)).not.toContain("demo");
    return manifest;
  }

  it("keeps the estimate form and the owner board working without demo.js or the demo fields", async () => {
    const app = await strippedApp();
    const rt = createFakeRuntime(strippedManifest());
    const ctx = rt.ctx as any; // The shared runtime harness, checked against the stripped manifest.

    const home = await (await get(app, ctx, "/")).text();
    expect(home).not.toContain("Demo app");
    expect((await post(app, ctx, "/estimate", request)).status).toBe(303);
    const [lead] = rt.state.rows.get("leads")!;
    expect(lead!.data).toMatchObject({ name: "Jordan Pike", stage: "new" });

    const signedOut = await get(app, ctx, "/admin");
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/_userland/auth/login");

    rt.setUser({ ...OWNER, app_user_id: OWNER.id });
    expect(await (await get(app, ctx, "/admin")).text()).toContain("Jordan Pike");
    expect((await post(app, ctx, `/admin/leads/${lead!.id}/stage`, { stage: "contacted", follow_up_on: "" })).status).toBe(303);
    expect((await post(app, ctx, `/admin/leads/${lead!.id}/notes`, { body: "Called back." })).status).toBe(303);
    const detail = await (await get(app, ctx, `/admin/leads/${lead!.id}`)).text();
    expect(detail).toContain("Called back.");
    expect(rt.state.rows.get("leads")![0]!.data.stage).toBe("contacted");
    expect((await post(app, ctx, `/admin/leads/${lead!.id}/delete`, { confirm: "yes" })).status).toBe(303);
    expect(rt.state.rows.get("leads")).toHaveLength(0);
  });

  // Runs all four steps on a copy of the whole example, then runs the copy's
  // remaining tests, so the steps can't leave a failing suite behind. Skipped
  // inside that copy, and once you've removed the demo yourself.
  it.skipIf(process.env.MINI_CRM_REMOVAL_CHECK === "1" || !fs.existsSync(path.join(EXAMPLE_DIR, "server/demo.js")))(
    "leaves a copy whose remaining tests pass",
    () => {
      const repoRoot = path.resolve(EXAMPLE_DIR, "../..");
      const target = path.resolve(EXAMPLE_DIR, "..", `mini-crm-removal-check-${process.pid}`);
      fs.cpSync(EXAMPLE_DIR, target, { recursive: true });
      try {
        fs.rmSync(path.join(target, "server/demo.js"), { force: true }); // Step 1
        const index = path.join(target, "server/index.js"); // Step 2
        fs.writeFileSync(index, withoutDemoImport(fs.readFileSync(index, "utf8")));
        const manifestPath = path.join(target, "manifest.userland.json"); // Step 3
        fs.writeFileSync(manifestPath, `${JSON.stringify(withoutDemoFields(JSON.parse(fs.readFileSync(manifestPath, "utf8"))), null, 2)}\n`);
        fs.rmSync(path.join(target, "tests/demo.test.ts"), { force: true }); // Step 4

        const vitest = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
        try {
          execFileSync(process.execPath, [vitest, "run", path.relative(repoRoot, target)], {
            cwd: repoRoot,
            env: { ...process.env, MINI_CRM_REMOVAL_CHECK: "1" },
            stdio: "pipe"
          });
        } catch (error: any) {
          throw new Error(`Tests failed after the removal steps:\n${error.stdout ?? ""}${error.stderr ?? ""}`);
        }
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    },
    120_000
  );
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest } from "../../../scripts/runtime-harness.js";
import { APP_ORIGIN, DEMO_ORIGIN, countingCtx, get, makeCtx, ownerPages, post, production, seedApproved, seedMany, validListing, type Ctx } from "./helpers.js";

describe("public board (production)", () => {
  it("lists approved jobs only and never shows contact details or notes", async () => {
    const ctx = makeCtx();
    await seedApproved(ctx);
    await seedApproved(ctx, { title: "Hidden pending job", status: "pending" });

    const response = await get(production, ctx, `${APP_ORIGIN}/`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Cheese cave assistant");
    expect(body).not.toContain("Hidden pending job");
    expect(body).not.toContain("ivy.lane@example.com");
    expect(body).not.toContain("Called them on Monday");
    expect(body).not.toContain('name="robots"');
  });

  it("filters by category and search words", async () => {
    const ctx = makeCtx();
    await seedApproved(ctx);
    await seedApproved(ctx, {
      title: "Orchard crew lead",
      employer: "Heron Hill Orchard",
      location: "Hood River, OR",
      summary: "Lead a pruning and harvest crew on 40 acres of pears.",
      category: "orchards",
      job_type: "full-time"
    });

    const byCategory = await (await get(production, ctx, `${APP_ORIGIN}/?category=orchards`)).text();
    expect(byCategory).toContain("Orchard crew lead");
    expect(byCategory).not.toContain("Cheese cave assistant");

    const bySearch = await (await get(production, ctx, `${APP_ORIGIN}/?q=cheese%20astoria`)).text();
    expect(bySearch).toContain("Cheese cave assistant");
    expect(bySearch).not.toContain("Orchard crew lead");
  });

  it("shows a job page for approved jobs and 404 for anything else", async () => {
    const ctx = makeCtx();
    const live = await seedApproved(ctx);
    const pending = await seedApproved(ctx, { status: "pending" });

    const page = await get(production, ctx, `${APP_ORIGIN}/jobs/${live.id}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('href="mailto:fog@example.com"');
    expect(html).toContain('"@type":"JobPosting"');
    expect(html).not.toContain("ivy.lane@example.com");

    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/${pending.id}`)).status).toBe(404);
    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/nope`)).status).toBe(404);
  });

  it("gives filtered and searched boards a readable tab title", async () => {
    const ctx = makeCtx();
    await seedApproved(ctx);
    const titleOf = async (query: string) => /<title>([^<]*)<\/title>/u.exec(await (await get(production, ctx, `${APP_ORIGIN}/${query}`)).text())?.[1];

    expect(await titleOf("?category=orchards&q=pear")).toBe("Jobs matching “pear” · Orchards &amp; vineyards · Loamwork");
    expect(await titleOf("?type=seasonal")).toBe("Seasonal jobs · Loamwork");
    expect(await titleOf("?q=%3Cb%3E")).toBe("Jobs matching “&lt;b&gt;” · Loamwork");
  });

  it("retries a page load once if reading data fails, but never repeats a form post", async () => {
    const ctx = makeCtx();
    const live = await seedApproved(ctx);
    const listings = ctx.data.collection("listings");
    let failures = 1;
    const flaky = {
      ...listings,
      async get(id: string) {
        if (failures-- > 0) throw new Error("data service unavailable");
        return listings.get(id);
      },
      async create(input: Record<string, unknown>) {
        if (failures-- > 0) throw new Error("data service unavailable");
        return listings.create(input);
      }
    };
    const flakyCtx = { ...ctx, data: { collection: (name: string) => (name === "listings" ? flaky : ctx.data.collection(name)) } };

    const page = await get(production, flakyCtx as Ctx, `${APP_ORIGIN}/jobs/${live.id}`);
    expect(page.status).toBe(200);
    expect(ctx.log.error).not.toHaveBeenCalled();

    failures = 1;
    const before = ctx.state.listings.length;
    const posted = await post(production, flakyCtx as Ctx, `${APP_ORIGIN}/post`, validListing);
    expect(posted.status).toBe(500);
    expect(ctx.state.listings.length).toBe(before);
    expect(ctx.log.error).toHaveBeenCalledTimes(1);
  });
});

describe("posting a job", () => {
  it("saves a valid listing as waiting for review", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, validListing);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/post/thanks");
    expect(ctx.state.listings).toHaveLength(1);
    expect(ctx.state.listings[0]).toMatchObject({ title: "Cheese cave assistant", status: "pending", featured: false });
    expect(ctx.log.info).toHaveBeenCalledWith("listing submitted", expect.objectContaining({ listing_id: ctx.state.listings[0].id }));

    const board = await (await get(production, ctx, `${APP_ORIGIN}/`)).text();
    expect(board).not.toContain("Cheese cave assistant");
  });

  it("re-shows the form with messages when fields are missing or invalid", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, contact_email: "not-an-email", apply_link: "javascript:alert(1)", category: "space" });
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(body).toContain("Please check 3 things");
    expect(body).toContain('aria-invalid="true"');
    expect(ctx.state.listings).toHaveLength(0);
  });

  it("enforces length limits", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, summary: "x".repeat(161) });
    expect(response.status).toBe(422);
    expect(ctx.state.listings).toHaveLength(0);
  });

  it("quietly drops submissions that fill in the hidden honeypot field", async () => {
    const ctx = makeCtx();
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, website: "https://spam.example.com" });
    expect(response.status).toBe(303);
    expect(ctx.state.listings).toHaveLength(0);
  });

  it("escapes HTML in everything a visitor typed", async () => {
    const ctx = makeCtx();
    await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, title: '<script>alert("x")</script> Farm hand' });
    const owner = await (await get(production, ctx, `${APP_ORIGIN}/owner`, "owner")).text();
    expect(owner).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Farm hand");
    expect(owner).not.toContain("<script>alert");
  });
});

describe("owner pages (production)", () => {
  it("sends signed-out visitors to the Userland sign-in page", async () => {
    const ctx = makeCtx();
    const response = await get(production, ctx, `${APP_ORIGIN}/owner?tab=pending`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fowner%3Ftab%3Dpending");
  });

  it("rejects signed-out and non-owner changes without touching data", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "pending" });

    const signedOut = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" });
    expect(signedOut.status).toBe(401);

    const helper = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" }, "helper");
    expect(helper.status).toBe(403);

    const edit = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}`, { ...validListing, title: "Hijacked" });
    expect(edit.status).toBe(401);

    expect(ctx.state.listings[0]).toMatchObject({ status: "pending", title: "Cheese cave assistant" });
    expect((await get(production, ctx, `${APP_ORIGIN}/owner`, "helper")).status).toBe(403);
  });

  it("refuses owner changes posted from another site, even with the owner signed in", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "pending" });
    const evil = "https://evil.apps.userland.fun";

    const approve = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" }, "owner", evil);
    expect(approve.status).toBe(403);
    const edit = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}`, { ...validListing, title: "Hijacked" }, "owner", evil);
    expect(edit.status).toBe(403);
    const spam = await post(production, ctx, `${APP_ORIGIN}/post`, validListing, undefined, evil);
    expect(spam.status).toBe(403);
    expect(ctx.state.listings).toHaveLength(1);
    expect(ctx.state.listings[0]).toMatchObject({ status: "pending", title: "Cheese cave assistant" });

    // The same request from the board's own pages goes through.
    const sameSite = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" }, "owner", APP_ORIGIN);
    expect(sameSite.status).toBe(303);
    expect(ctx.state.listings[0]).toMatchObject({ status: "approved" });
  });

  it("lets the owner approve, edit, and close a listing", async () => {
    const ctx = makeCtx();
    await post(production, ctx, `${APP_ORIGIN}/post`, validListing);
    const id = ctx.state.listings[0].id;

    const queue = await get(production, ctx, `${APP_ORIGIN}/owner`, "owner");
    const queueHtml = await queue.text();
    expect(queue.status).toBe(200);
    expect(queueHtml).toContain("ivy.lane@example.com");
    expect(queueHtml).toContain("Waiting for review");

    const approve = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${id}/status`, { status: "approved" }, "owner");
    expect(approve.status).toBe(303);
    expect(ctx.state.listings[0]).toMatchObject({ status: "approved" });
    expect(ctx.state.listings[0].published_at).toBeTruthy();
    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/${id}`)).status).toBe(200);

    const edit = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${id}`, { ...validListing, title: "Cheese cave lead", featured: "on", owner_note: "Great fit" }, "owner");
    expect(edit.status).toBe(303);
    expect(ctx.state.listings[0]).toMatchObject({ title: "Cheese cave lead", featured: true, owner_note: "Great fit", status: "approved" });

    await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${id}/status`, { status: "closed" }, "owner");
    expect((await get(production, ctx, `${APP_ORIGIN}/jobs/${id}`)).status).toBe(404);
    const history = (ctx.state.listings[0].history as Array<{ action: string }>).map((entry) => entry.action);
    expect(history).toEqual(["submitted", "approved", "edited", "closed"]);
  });
});

describe("HEAD requests", () => {
  it("answer every page like GET, without a body", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx);
    const owner = { cookie: "__Host-ul_session=owner" };
    const pages: Array<[string, number, Record<string, string>?]> = [
      [`${APP_ORIGIN}/`, 200],
      [`${APP_ORIGIN}/jobs/${row.id}`, 200],
      [`${APP_ORIGIN}/post`, 200],
      [`${APP_ORIGIN}/post/thanks`, 200],
      [`${APP_ORIGIN}/owner`, 303],
      [`${APP_ORIGIN}/owner`, 200, owner],
      [`${APP_ORIGIN}/owner/jobs/${row.id}`, 200, owner],
      [`${APP_ORIGIN}/owner/jobs/${row.id}/delete`, 200, owner],
      [`${APP_ORIGIN}/owner/declined/delete`, 200, owner],
      [`${APP_ORIGIN}/missing`, 404]
    ];
    for (const [url, status, headers] of pages) {
      expect((await expectHeadLikeGet(production, ctx, url, { headers })).status).toBe(status);
    }
    expect(ctx.state.listings).toHaveLength(1);
  });
});

describe("removing the demo", () => {
  // Follows the steps in README.md on a copy of server/ and the manifest, then
  // runs a listing from submission to approval on the shared runtime harness.
  async function strippedApp() {
    const source = path.resolve(import.meta.dirname, "../server");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "job-board-no-demo-"));
    for (const name of fs.readdirSync(source)) {
      if (name === "demo.js") continue;
      fs.copyFileSync(path.join(source, name), path.join(target, name));
    }
    // Once the demo is gone from server/, these edits find nothing to change.
    const kept = fs
      .readFileSync(path.join(target, "index.js"), "utf8")
      .split("\n")
      .filter((line) => !line.startsWith('import { demoMode } from "./demo.js";'))
      .map((line) => (line.startsWith("export default createApp({ demo: demoMode });") ? "export default createApp();" : line));
    expect(kept.join("\n")).not.toContain("demo.js\"");
    expect(kept).toContain("export default createApp();");
    fs.writeFileSync(path.join(target, "index.js"), kept.join("\n"));
    return (await import(pathToFileURL(path.join(target, "index.js")).href)).default;
  }

  it("leaves no demo code in the tests that stay", () => {
    // Step 4 deletes tests/demo.test.ts; the files that remain must not need demo.js.
    for (const name of ["helpers.ts", "job-board.test.ts"]) {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, name), "utf8");
      expect(source).not.toMatch(/from "\.\.\/server\/demo\.js"/u);
    }
  });

  it("keeps posting, review, and the public board working, even at the demo address", async () => {
    const server = await strippedApp();
    const manifest = readExampleManifest(path.resolve(import.meta.dirname, "..")) as any;
    delete manifest.resources.data.collections["demo-listings"];
    const rt = createFakeRuntime(manifest);
    const ctx = rt.ctx as any;

    const submitted = await post(server, ctx, `${DEMO_ORIGIN}/post`, validListing);
    expect(submitted.status).toBe(303);
    const [row] = rt.state.rows.get("listings")!;
    expect(row!.data.status).toBe("pending");

    const signedOut = await get(server, ctx, `${DEMO_ORIGIN}/owner`);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/_userland/auth/login");

    rt.setUser({ id: "appusr_owner", app_user_id: "appusr_owner", email: "owner@example.com", roles: ["owner"] });
    expect(await (await get(server, ctx, `${APP_ORIGIN}/owner`)).text()).toContain("Cheese cave assistant");
    expect((await post(server, ctx, `${APP_ORIGIN}/owner/jobs/${row!.id}/status`, { status: "approved" })).status).toBe(303);
    rt.setUser(null);
    expect(await (await get(server, ctx, `${APP_ORIGIN}/`)).text()).toContain("Cheese cave assistant");
  });
});

describe("long lists (more than one page of data)", () => {
  it("lets the owner reach, review, and close listings far past the newest 100", async () => {
    const ctx = makeCtx();
    // 120 live jobs, then 110 waiting for review: 230 listings in all.
    const live = await seedMany(ctx, 120, (index) => ({ title: `Live job ${index}`, status: "approved" }));
    const waiting = await seedMany(ctx, 110, (index) => ({ title: `Waiting job ${index}`, status: "pending", submitted_at: new Date(Date.UTC(2026, 7, 1) + index * 60_000).toISOString(), published_at: "" }));

    const first = await (await get(production, ctx, `${APP_ORIGIN}/owner`, "owner")).text();
    expect(first).toMatch(/To review <span class="count">100\+<\/span>/u);
    const liveTab = await (await get(production, ctx, `${APP_ORIGIN}/owner?tab=approved`, "owner")).text();
    expect(liveTab).toMatch(/Live <span class="count">100\+<\/span>/u);

    // Paging through the review queue reaches every waiting listing, including the oldest.
    const pending = await ownerPages(production, ctx, "pending");
    expect(pending.length).toBe(2);
    const titles = pending.join("").match(/Waiting job \d+/gu) ?? [];
    expect(new Set(titles).size).toBe(110);
    expect(pending.join("")).not.toContain("Live job");

    // The oldest waiting listing can be approved, and the oldest live job marked as filled.
    expect((await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${waiting[0].id}/status`, { status: "approved" }, "owner")).status).toBe(303);
    expect((await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${live[0].id}/status`, { status: "closed" }, "owner")).status).toBe(303);
    const closed = await ownerPages(production, ctx, "closed");
    expect(closed.join("")).toContain("Live job 0<");
    const approved = (await ownerPages(production, ctx, "approved")).join("");
    expect(approved).toContain("Waiting job 0<");
    expect(approved).toContain("Live job 1<");
  });

  it("reaches every live job on the public board, 100 at a time, with exact filters", async () => {
    const ctx = makeCtx();
    await seedMany(ctx, 130, (index) => ({
      title: `Farm job ${index}`,
      category: index === 0 ? "orchards" : "livestock",
      job_type: index === 0 ? "seasonal" : "full-time",
      summary: index === 0 ? "The very first pear orchard job on the board." : validListing.summary
    }));
    const nextLink = (body: string) => /<a [^>]*href="([^"]+)" rel="next">Older jobs<\/a>/u.exec(body)?.[1]?.replaceAll("&amp;", "&");

    const board = await (await get(production, ctx, `${APP_ORIGIN}/`)).text();
    expect(board).toContain("100+ open jobs");
    expect(board).toContain("100 jobs on this page");
    expect(board).toContain("Farm job 129<");
    expect(board).not.toContain("Farm job 29<");

    // "Older jobs" reads the next 100 and reaches the oldest live job.
    const older = await (await get(production, ctx, `${APP_ORIGIN}${nextLink(board)}`)).text();
    expect(older).toContain("30 jobs on this page");
    expect(older).toContain("Farm job 0<");
    expect(older).toContain("Farm job 29<");
    expect(older).not.toContain("Farm job 30<");
    expect(older).toContain("Back to the newest");
    expect(nextLink(older)).toBeUndefined();

    // Category and schedule filters are part of the data query, so they cover every live job.
    for (const query of ["?category=orchards", "?type=seasonal", "?category=orchards&type=seasonal"]) {
      const filtered = await (await get(production, ctx, `${APP_ORIGIN}/${query}`)).text();
      expect(filtered).toMatch(/<h2 id="results-title">1 job /u);
      expect(filtered).toContain("Farm job 0<");
      expect(nextLink(filtered)).toBeUndefined();
    }
    expect(await (await get(production, ctx, `${APP_ORIGIN}/?category=orchards&type=full-time`)).text()).toContain("Nothing matches those filters");

    // Search words look through one page at a time and say so, with a link to older jobs.
    const search = await (await get(production, ctx, `${APP_ORIGIN}/?q=pear`)).text();
    expect(search).not.toContain("Farm job 0<");
    expect(search).toContain("Search looks through 100 jobs at a time");
    const searchOlder = await (await get(production, ctx, `${APP_ORIGIN}${nextLink(search)}`)).text();
    expect(searchOlder).toContain("Farm job 0<");
    expect(searchOlder).toMatch(/1 job on this page/u);
  });

  it("keeps each page to one or two full reads of the data, even with 1,000 listings", async () => {
    const base = makeCtx();
    // 600 live, 100 waiting, 200 declined, 100 closed: every row Free allows.
    const live = await seedMany(base, 600, (index) => ({ title: `Live job ${index}`, category: index % 2 ? "livestock" : "orchards" }));
    await seedMany(base, 100, (index) => ({ title: `Waiting job ${index}`, status: "pending", contact_email: `employer${index}@example.com` }));
    await seedMany(base, 200, (index) => ({ title: `Declined job ${index}`, status: "rejected" }));
    await seedMany(base, 100, (index) => ({ title: `Closed job ${index}`, status: "closed" }));
    const { ctx, calls, reset } = countingCtx(base);

    const pages: Array<[string, number, string?]> = [
      ["/", 1],
      ["/?category=orchards&type=full-time&q=cheese", 1],
      [`/jobs/${live[0].id}`, 1],
      ["/owner", 1, "owner"],
      ["/owner?tab=approved", 2, "owner"],
      ["/owner?tab=all", 2, "owner"],
      ["/owner?tab=rejected&done=rejected&id=nope", 2, "owner"],
      ["/owner/declined/delete", 1, "owner"]
    ];
    for (const [path, lists, session] of pages) {
      reset();
      const response = await get(production, ctx, `${APP_ORIGIN}${path}`, session);
      expect(response.status, path).toBe(200);
      expect(calls.list ?? 0, path).toBe(lists);
    }

    // "Show more" pages and older board pages are one or two reads as well.
    reset();
    const more = await ownerPages(production, ctx, "approved");
    expect(more.length).toBe(6);
    expect(calls.list).toBe(more.length * 2);
  });
  it("ignores a broken “Show more” link and starts from the first page", async () => {
    const ctx = makeCtx();
    await seedApproved(ctx, { status: "pending" });
    for (const after of ["%%%", "abc", "x".repeat(200)]) {
      const response = await get(production, ctx, `${APP_ORIGIN}/owner?tab=pending&after=${after}`, "owner");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Cheese cave assistant");
    }
  });
});

describe("spam limits and cleanup", () => {
  async function seedPending(ctx: Ctx, count: number, email = (index: number) => `employer${index}@example.com`) {
    return await seedMany(ctx, count, (index) => ({ title: `Waiting job ${index}`, status: "pending", published_at: "", contact_email: email(index) }));
  }
  const pendingCount = (ctx: Ctx) => ctx.state.listings.filter((row) => row.status === "pending").length;

  it("pauses new listings once 100 are waiting for review", async () => {
    const ctx = makeCtx();
    await seedPending(ctx, 100);
    const response = await post(production, ctx, `${APP_ORIGIN}/post`, validListing);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("New listings are paused for now");
    expect(pendingCount(ctx)).toBe(100);

    // Clearing the queue makes room again.
    await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${ctx.state.listings[0].id}/status`, { status: "rejected" }, "owner");
    expect((await post(production, ctx, `${APP_ORIGIN}/post`, validListing)).status).toBe(303);
  });

  it("holds the 100-listing limit when many posts arrive at the same moment", async () => {
    const ctx = makeCtx();
    await seedPending(ctx, 97);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, title: `Rush job ${index}`, contact_email: `rush${index}@example.com` }))
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 303)).toHaveLength(3);
    expect(statuses.filter((status) => status === 503)).toHaveLength(5);
    expect(pendingCount(ctx)).toBe(100);
  });

  it("lets one email have only 3 listings waiting at a time", async () => {
    const ctx = makeCtx();
    for (let index = 0; index < 3; index += 1) {
      expect((await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, contact_email: index === 1 ? "IVY.LANE@example.com" : validListing.contact_email })).status).toBe(303);
    }
    const fourth = await post(production, ctx, `${APP_ORIGIN}/post`, validListing);
    expect(fourth.status).toBe(429);
    expect(await fourth.text()).toContain("You already have listings waiting");
    expect(ctx.state.listings).toHaveLength(3);
    expect((await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, contact_email: "someone.else@example.com" })).status).toBe(303);
  });

  it("holds the 3-per-email limit when one email posts many times at once", async () => {
    const ctx = makeCtx();
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, title: `Same sender ${index}` })));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 303)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
    expect(pendingCount(ctx)).toBe(3);
  });

  it("shows a clear page when the plan's saved-row allowance is used up", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "pending" });
    const listings = ctx.data.collection("listings");
    const full = Object.assign(new Error("data.rows.max quota exceeded for the current plan."), { code: "quota_exceeded", status: 402 });
    const quotaCtx = {
      ...ctx,
      data: {
        ...ctx.data,
        collection: (name: string) => ({
          ...listings,
          async create() {
            throw full;
          },
          async update() {
            throw full;
          }
        })
      }
    } as Ctx;

    const posted = await post(production, quotaCtx, `${APP_ORIGIN}/post`, validListing);
    expect(posted.status).toBe(503);
    expect(await posted.text()).toContain("New listings are paused for now");

    const owner = await post(production, quotaCtx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status: "approved" }, "owner");
    expect(owner.status).toBe(503);
    expect(await owner.text()).toContain("Delete declined or closed listings to make room");
  });

  it("lets the owner delete a listing after confirming", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "rejected", title: "Earn money fast" });
    const confirm = await get(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/delete`, "owner");
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("Delete “Earn money fast”?");
    expect(ctx.state.listings).toHaveLength(1);

    const deleted = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/delete`, {}, "owner", APP_ORIGIN);
    expect(deleted.status).toBe(303);
    expect(ctx.state.listings).toHaveLength(0);
    const after = await (await get(production, ctx, `${APP_ORIGIN}${deleted.headers.get("location")}`, "owner")).text();
    expect(after).toContain("The listing is deleted.");
    expect((await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/delete`, {}, "owner")).status).toBe(404);
  });

  it("only lets the signed-in owner delete, and only from the board's own pages", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "rejected" });
    const url = `${APP_ORIGIN}/owner/jobs/${row.id}/delete`;
    expect((await post(production, ctx, url, {})).status).toBe(401);
    expect((await post(production, ctx, url, {}, "helper")).status).toBe(403);
    expect((await get(production, ctx, url)).status).toBe(303);
    for (const origin of ["https://evil.apps.userland.fun", "null"]) {
      expect((await post(production, ctx, url, {}, "owner", origin)).status).toBe(403);
      expect((await post(production, ctx, `${APP_ORIGIN}/owner/declined/delete`, {}, "owner", origin)).status).toBe(403);
    }
    expect((await post(production, ctx, `${APP_ORIGIN}/owner/declined/delete`, {})).status).toBe(401);
    expect(ctx.state.listings).toHaveLength(1);
  });

  it("deletes declined listings in batches and leaves the rest alone", async () => {
    const ctx = makeCtx();
    await seedMany(ctx, 20, (index) => ({ title: `Spam ${index}`, status: "rejected" }));
    await seedApproved(ctx, { title: "Keep me live" });
    await seedApproved(ctx, { title: "Keep me waiting", status: "pending" });

    const confirm = await (await get(production, ctx, `${APP_ORIGIN}/owner/declined/delete`, "owner")).text();
    expect(confirm).toContain("the first 15 of 20 declined listings");

    const first = await post(production, ctx, `${APP_ORIGIN}/owner/declined/delete`, {}, "owner");
    expect(first.status).toBe(303);
    expect(ctx.state.listings.filter((row) => row.status === "rejected")).toHaveLength(5);
    const firstPage = await (await get(production, ctx, `${APP_ORIGIN}${first.headers.get("location")}`, "owner")).text();
    expect(firstPage).toContain("Deleted 15 declined listings. There are more");

    const second = await post(production, ctx, `${APP_ORIGIN}/owner/declined/delete`, {}, "owner");
    const secondPage = await (await get(production, ctx, `${APP_ORIGIN}${second.headers.get("location")}`, "owner")).text();
    expect(secondPage).toContain("Deleted 5 declined listings.");
    expect(secondPage).not.toContain("There are more");
    expect(ctx.state.listings.map((row) => row.title).sort()).toEqual(["Keep me live", "Keep me waiting"]);
  });
});

describe("odd input", () => {
  it("treats built-in object names as unknown actions and messages", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { status: "pending" });
    for (const status of ["constructor", "__proto__", "toString", "deleted"]) {
      const response = await post(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}/status`, { status }, "owner");
      expect(response.status).toBe(400);
    }
    expect(ctx.state.listings[0].status).toBe("pending");

    for (const done of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
      const response = await get(production, ctx, `${APP_ORIGIN}/owner?done=${done}&id=${row.id}`, "owner");
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toContain("[object");
      expect(body).not.toContain('class="flash"');
    }
  });

  it("refuses email addresses that could add hidden recipients to an email link", async () => {
    const ctx = makeCtx();
    for (const fields of [
      { apply_link: "jobs@farm.example?bcc=spy%40evil.example" },
      { apply_link: "jobs@farm.example&cc=spy@evil.example" },
      { contact_email: "ivy@farm.example?subject=hi" },
      { contact_email: "ivy#x@farm.example" }
    ]) {
      const response = await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, ...fields });
      expect(response.status).toBe(422);
    }
    expect(ctx.state.listings).toHaveLength(0);
    expect((await post(production, ctx, `${APP_ORIGIN}/post`, { ...validListing, apply_link: "o'neil+jobs@farm-co.example.org" })).status).toBe(303);
  });

  it("never turns an older, unsafe address into an email link", async () => {
    const ctx = makeCtx();
    const row = await seedApproved(ctx, { apply_link: "jobs@farm.example?bcc=spy%40evil.example", contact_email: "ivy@farm.example?bcc=spy@evil.example" });
    const job = await (await get(production, ctx, `${APP_ORIGIN}/jobs/${row.id}`)).text();
    expect(job).not.toContain("mailto:");
    const owner = await (await get(production, ctx, `${APP_ORIGIN}/owner?tab=approved`, "owner")).text();
    expect(owner).not.toContain("mailto:");
    const edit = await (await get(production, ctx, `${APP_ORIGIN}/owner/jobs/${row.id}`, "owner")).text();
    expect(edit).not.toContain("mailto:");
  });
});

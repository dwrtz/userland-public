import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { createApp } from "../server/index.js";
import { APP_ORIGIN, DEMO_ORIGIN, get, makeCtx, post, production, seedApproved, validListing, type Ctx } from "./helpers.js";

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
    expect(ctx.log.info).toHaveBeenCalledWith("listing submitted", expect.objectContaining({ listing_id: "row_1" }));

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

  it("keeps demo mode off on any host other than the demo host", async () => {
    const ctx = makeCtx();
    const response = await get(app, ctx, `${APP_ORIGIN}/owner`);
    expect(response.status).toBe(303);
    expect(ctx.state["demo-listings"]).toHaveLength(0);
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

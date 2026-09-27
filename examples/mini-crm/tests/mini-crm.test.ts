import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { createApp } from "../server/index.js";
import { ORIGIN, get, makeCtx, post, request } from "./helpers.js";

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
    expect(ctx.state.activity[0]).toMatchObject({ lead_id: ctx.state.leads[0].id, kind: "received" });
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
    const ctx = makeCtx({ user: { id: "u_1", email: "owner@example.com", roles: ["owner"] } });

    const created = await post(app, ctx, "/admin/leads", { ...request, source: "referral", timeline: "" });
    expect(created.status).toBe(303);
    const leadId = ctx.state.leads[0].id;
    expect(created.headers.get("location")).toBe(`/admin/leads/${leadId}?saved=created`);
    expect(ctx.state.activity[0]).toMatchObject({ kind: "added" });

    const updated = await post(app, ctx, `/admin/leads/${leadId}/stage`, { stage: "site_visit", follow_up_on: "2026-10-02" });
    expect(updated.status).toBe(303);
    expect(ctx.state.leads[0]).toMatchObject({ stage: "site_visit", follow_up_on: "2026-10-02" });

    const badDate = await post(app, ctx, `/admin/leads/${leadId}/stage`, { stage: "quoted", follow_up_on: "2026-02-31" });
    expect(badDate.status).toBe(422);
    expect(ctx.state.leads[0].stage).toBe("site_visit");

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
});

describe("turning demo mode off", () => {
  // Follows the steps in README.md on a copy of server/ and the manifest, then
  // checks the public form and the owner board still work.
  async function strippedApp() {
    const source = path.resolve(import.meta.dirname, "../server");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "mini-crm-no-demo-"));
    for (const name of fs.readdirSync(source)) {
      if (name === "demo.js") continue;
      fs.copyFileSync(path.join(source, name), path.join(target, name));
    }
    // Once demo mode is gone from server/, these edits find nothing to change.
    const kept = fs
      .readFileSync(path.join(target, "index.js"), "utf8")
      .split("\n")
      .filter((line) => !line.startsWith('import { demo } from "./demo.js";'))
      .map((line) => (line === "export default createApp({ demo });" ? "export default createApp();" : line));
    expect(kept.join("\n")).not.toContain("demo.js\"");
    expect(kept).toContain("export default createApp();");
    fs.writeFileSync(path.join(target, "index.js"), kept.join("\n"));
    return (await import(pathToFileURL(path.join(target, "index.js")).href)).default;
  }

  function strippedManifest() {
    const manifest = readExampleManifest(path.resolve(import.meta.dirname, "..")) as any;
    for (const collection of Object.values(manifest.resources.data.collections) as any[]) {
      delete collection.fields.demo_visitor;
      collection.indexes = collection.indexes.filter((index: { name: string }) => index.name !== "by_demo_visitor");
    }
    expect(JSON.stringify(manifest)).not.toContain("demo");
    return manifest;
  }

  it("keeps the estimate form and the owner board working without demo.js or the demo_visitor fields", async () => {
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

    rt.setUser({ id: "u_1", app_user_id: "u_1", email: "owner@example.com", roles: ["owner"] });
    expect(await (await get(app, ctx, "/admin")).text()).toContain("Jordan Pike");
    expect((await post(app, ctx, `/admin/leads/${lead!.id}/stage`, { stage: "contacted", follow_up_on: "" })).status).toBe(303);
    expect((await post(app, ctx, `/admin/leads/${lead!.id}/notes`, { body: "Called back." })).status).toBe(303);
    const detail = await (await get(app, ctx, `/admin/leads/${lead!.id}`)).text();
    expect(detail).toContain("Called back.");
    expect(rt.state.rows.get("leads")![0]!.data.stage).toBe("contacted");
  });
});

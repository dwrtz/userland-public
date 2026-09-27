// Tests for the public demo's demo mode (server/demo.js). Delete this file
// together with server/demo.js when you remove demo mode (see README.md).
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { MAX_OPEN_DESKS, startDemo } from "../server/demo.js";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
import { DEMO, SITE, location, makeCtx, post, requestQuote, row, rows, send, text, type FakeCtx } from "./helpers.js";

const KEY = /^[0-9a-z]{7}[A-Za-z0-9_-]{16}$/;
const HOUR = 60 * 60 * 1000;

describe("demo mode", () => {
  async function openDesk(ctx: FakeCtx) {
    const response = await send(ctx, post(`${DEMO}/demo/start`, {}));
    expect(response.status).toBe(303);
    const target = location(response);
    expect(target).toMatch(/^\/desk\?demo=/);
    const key = target.split("demo=")[1];
    expect(key).toMatch(KEY);
    return key;
  }

  it("shows a start page instead of a sign-in on the demo host", async () => {
    const ctx = makeCtx();
    const response = await send(ctx, `${DEMO}/desk`);
    expect(response.status).toBe(200);
    const html = await text(response);
    expect(html).toContain("Open the studio desk");
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain('href="https://userland.fun/examples/invoice-generator/"');
    expect(ctx.auth.requireRole).not.toHaveBeenCalled();
    expect(rows(ctx, "documents")).toHaveLength(0);
  });

  it("answers HEAD like GET, without a body", async () => {
    const ctx = makeCtx();
    for (const pathname of ["/", "/desk"]) {
      expect((await expectHeadLikeGet(app, ctx, `${DEMO}${pathname}`)).status).toBe(200);
    }
  });

  it("gives each visitor sample data and schedules cleanup", async () => {
    const ctx = makeCtx();
    const enqueue = vi.spyOn(ctx.jobs, "enqueue");
    const key = await openDesk(ctx);
    expect(enqueue).toHaveBeenCalledWith("clear-demo", { workspace: `demo-${key}` }, { delay_seconds: 6 * 60 * 60 });
    const html = await text(await send(ctx, `${DEMO}/desk?demo=${key}`));
    expect(html).toContain("Fieldnote Coffee Roasters");
    expect(html).toContain("Overdue");
    expect(html).toContain('content="noindex,follow"');
    expect(html).toContain("Demo app. Built with Userland.");
    expect(html).not.toMatch(/sandbox|seed|fixture|tenant|manifest/i);
    expect(rows(ctx, "documents").every((row) => row.workspace === `demo-${key}`)).toBe(true);
    expect(ctx.runtime.state.enqueued).toEqual([{ name: "clear-demo", payload: { workspace: `demo-${key}` } }]);
  });

  it("never shows one visitor's submissions or changes to another visitor", async () => {
    const ctx = makeCtx();
    const keyA = await openDesk(ctx);
    const keyB = await openDesk(ctx);

    // Visitor A sends a quote request from the public page with their key.
    await requestQuote(ctx, DEMO, { name: "Private Person", email: "private@example.com" });
    const requestA = await send(ctx, post(`${DEMO}/request?demo=${keyA}`, { name: "Ada Secret", email: "ada.secret@example.com", service: "web", message: "Only for A", website: "" }));
    expect(location(requestA)).toContain(`demo=${keyA}`);

    const deskA = await text(await send(ctx, `${DEMO}/desk?demo=${keyA}`));
    const deskB = await text(await send(ctx, `${DEMO}/desk?demo=${keyB}`));
    expect(deskA).toContain("Ada Secret");
    expect(deskB).not.toContain("Ada Secret");
    expect(deskA).not.toContain("Private Person");
    expect(deskB).not.toContain("Private Person");

    // A status change in A's workspace doesn't touch B's copy of the same sample.
    const sentA = rows(ctx, "documents").find((row) => row.workspace === `demo-${keyA}` && row.title === "Packaging system for three blends")!;
    const sentB = rows(ctx, "documents").find((row) => row.workspace === `demo-${keyB}` && row.title === "Packaging system for three blends")!;
    await send(ctx, post(`${DEMO}/desk/documents/${sentA.id}/status?demo=${keyA}`, { status: "accepted" }));
    expect(row(ctx, "documents", sentA.id)?.status).toBe("accepted");
    expect(row(ctx, "documents", sentB.id)?.status).toBe("sent");

    // B can't open or change A's documents, even by id.
    expect((await send(ctx, `${DEMO}/desk/documents/${sentA.id}?demo=${keyB}`)).status).toBe(404);
    await send(ctx, post(`${DEMO}/desk/documents/${sentA.id}/status?demo=${keyB}`, { status: "declined" }));
    expect(row(ctx, "documents", sentA.id)?.status).toBe("accepted");
  });

  it("a request without a key opens a new private workspace for that visitor", async () => {
    const ctx = makeCtx();
    const response = await requestQuote(ctx, DEMO, { name: "New Visitor", email: "new@example.com" });
    const target = location(response);
    expect(target).toMatch(/^\/request\/sent\?demo=/);
    const key = target.split("demo=")[1];
    expect(key).toMatch(KEY);
    const thanks = await text(await send(ctx, `${DEMO}${target}`));
    expect(thanks).toContain(`/desk?view=requests&amp;demo=${key}`);
    const desk = await text(await send(ctx, `${DEMO}/desk?view=requests&demo=${key}`));
    expect(desk).toContain("New Visitor");
  });

  it("ignores a key the server never issued, and writes nothing for it", async () => {
    const ctx = makeCtx();
    const madeUp = "0tm0y8bauditFixation001";
    expect(madeUp).toMatch(KEY);
    const desk = await send(ctx, `${DEMO}/desk?demo=${madeUp}`);
    expect(desk.status).toBe(200);
    const html = await text(desk);
    expect(html).toContain("Try the owner&#39;s side");
    expect(html).not.toContain(madeUp);

    // A request sent with the made-up key opens a fresh workspace instead.
    const request = await send(ctx, post(`${DEMO}/request?demo=${madeUp}`, { name: "Visitor", email: "visitor@example.com", service: "web", message: "Hi", website: "" }));
    expect(location(request)).toMatch(/^\/request\/sent\?demo=/);
    expect(location(request)).not.toContain(madeUp);
    const home = await text(await send(ctx, `${DEMO}/?demo=${madeUp}`));
    expect(home).not.toContain(`demo=${madeUp}`);
    expect(rows(ctx, "documents").some((item) => item.workspace === `demo-${madeUp}`)).toBe(false);
    expect(rows(ctx, "clients").some((item) => item.workspace === `demo-${madeUp}`)).toBe(false);
  });

  it("sends an expired key back to the start page, and sweeps workspaces that were never cleared", async () => {
    const ctx = makeCtx();
    const old = await startDemo(ctx, new Date(Date.now() - 7 * HOUR));
    expect(old.key).toMatch(KEY);
    const html = await text(await send(ctx, `${DEMO}/desk?demo=${old.key}`));
    expect(html).toContain("That demo desk has been cleared.");
    expect(html).not.toContain("Fieldnote Coffee Roasters");

    // A workspace from an old-style key, whose own cleanup never ran.
    await ctx.data.collection("clients").create({ workspace: "demo-AAAAAAAAAAAAAAAAAAAA", name: "Left behind", company: "", email: "left@example.com", address: "", notes: "" });
    const current = await openDesk(ctx);
    await app.job({ job_id: "job_1", name: "clear-demo", payload: { workspace: `demo-${current}` } }, ctx);
    const workspaces = new Set([...rows(ctx, "documents"), ...rows(ctx, "clients")].map((item) => item.workspace));
    expect(workspaces.size).toBe(0);
  });

  it("opens no workspace when its cleanup can't be scheduled", async () => {
    const ctx = makeCtx();
    vi.spyOn(ctx.jobs, "enqueue").mockRejectedValue(Object.assign(new Error("Monthly job runs used up."), { code: "quota_exceeded" }));
    const response = await send(ctx, post(`${DEMO}/demo/start`, {}));
    expect(response.status).toBe(503);
    expect(await text(response)).toContain("The demo is busy");
    const request = await requestQuote(ctx, DEMO);
    expect(request.status).toBe(503);
    expect(rows(ctx, "documents")).toHaveLength(0);
    expect(rows(ctx, "clients")).toHaveLength(0);
  });

  it("caps how many demo desks are open at once", async () => {
    const ctx = makeCtx();
    for (let index = 0; index < MAX_OPEN_DESKS; index += 1) await startDemo(ctx);
    const before = rows(ctx, "documents").length;
    const response = await send(ctx, post(`${DEMO}/demo/start`, {}));
    expect(response.status).toBe(503);
    expect(rows(ctx, "documents")).toHaveLength(before);
  });

  it("refuses to open a demo desk from another site", async () => {
    const ctx = makeCtx();
    const response = await send(ctx, post(`${DEMO}/demo/start`, {}, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(rows(ctx, "documents")).toHaveLength(0);
  });

  it("sends public pages on the app's own address to the demo, and keeps its desk signed in", async () => {
    const ctx = makeCtx();
    const own = "https://3ls259ymzm94r65h4v4.apps.userland.fun";
    const home = await send(ctx, `${own}/?x=1`);
    expect(home.status).toBe(303);
    expect(location(home)).toBe(`${DEMO}/?x=1`);
    const request = await requestQuote(ctx, own);
    expect(location(request)).toBe(`${DEMO}/`);
    expect(rows(ctx, "documents")).toHaveLength(0);
    const desk = await send(ctx, `${own}/desk`);
    expect(desk.status).toBe(303);
    expect(location(desk)).toContain("/_userland/auth/login");
    expect(ctx.auth.requireRole).toHaveBeenCalledWith(expect.any(Request), "owner");
  });

  it("the clear-demo job deletes one visitor workspace and never real data", async () => {
    const ctx = makeCtx();
    await requestQuote(ctx, SITE);
    const keyA = await openDesk(ctx);
    const keyB = await openDesk(ctx);
    await app.job({ job_id: "job_1", name: "clear-demo", payload: { workspace: `demo-${keyA}` } }, ctx);
    await app.job({ job_id: "job_2", name: "clear-demo", payload: { workspace: "main" } }, ctx);
    const workspaces = new Set([...rows(ctx, "documents"), ...rows(ctx, "clients")].map((row) => row.workspace));
    expect(workspaces).toEqual(new Set(["main", `demo-${keyB}`]));
  });
});

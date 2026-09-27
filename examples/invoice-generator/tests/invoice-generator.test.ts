import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { computeTotals, parseMoney, today } from "../server/store.js";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
import { DEMO, OWNER, SITE, location, makeCtx, post, requestQuote, row, rows, send, text, type FakeCtx } from "./helpers.js";

describe("money", () => {
  it("parses prices into cents and computes stored totals", () => {
    expect(parseMoney("1,250.5")).toBe(125050);
    expect(parseMoney("$40")).toBe(4000);
    expect(parseMoney("abc")).toBeNull();
    const totals = computeTotals(
      [
        { description: "Design", quantity: 3, unit_cents: 120000 },
        { description: "Retouching", quantity: 2.5, unit_cents: 1999 }
      ],
      8.25
    );
    expect(totals.subtotal_cents).toBe(364998);
    expect(totals.tax_cents).toBe(30112);
    expect(totals.total_cents).toBe(395110);
    expect(totals.line_items[1].amount_cents).toBe(4998);
  });

  it("dates documents in the studio's time zone, not UTC", () => {
    // 10:30 pm in Portland is already the next day in UTC.
    expect(today(new Date("2026-09-28T05:30:00Z"))).toBe("2026-09-27");
    expect(today(new Date("2026-09-28T08:00:00Z"))).toBe("2026-09-28");
  });
});

describe("owner gate (no demo mode)", () => {
  it("sends signed-out visitors to the Userland sign-in page", async () => {
    const ctx = makeCtx();
    const response = await send(ctx, `${SITE}/desk?view=invoices`);
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/_userland/auth/login?return_to=%2Fdesk%3Fview%3Dinvoices");
    expect(ctx.auth.requireRole).toHaveBeenCalledWith(expect.any(Request), "owner");
  });

  it("rejects signed-out and non-owner writes", async () => {
    const signedOut = makeCtx();
    const write = await send(signedOut, post(`${SITE}/desk/clients`, { name: "X", email: "x@example.com" }));
    expect(write.status).toBe(401);
    expect(rows(signedOut, "clients")).toHaveLength(0);

    const helper = makeCtx({ user: { id: "appusr_2", app_user_id: "appusr_2", email: "helper@example.com", roles: [] } });
    const page = await send(helper, `${SITE}/desk`);
    expect(page.status).toBe(403);
    const status = await send(helper, post(`${SITE}/desk/documents/documents_1/status`, { status: "paid" }));
    expect(status.status).toBe(403);
  });

  it("never opens the desk without sign-in, even with a demo key in the address", async () => {
    const ctx = makeCtx();
    const response = await send(ctx, `${SITE}/desk?demo=AAAAAAAAAAAAAAAAAAAA`);
    expect(response.status).toBe(303);
    expect(location(response)).toContain("/_userland/auth/login");
    expect((await send(ctx, post(`${SITE}/demo/start`, {}))).status).toBe(404);
  });

  it("lets the owner in", async () => {
    const ctx = makeCtx({ user: OWNER });
    const response = await send(ctx, `${SITE}/desk`);
    expect(response.status).toBe(200);
    const html = await text(response);
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Demo app");
  });
});

describe("public quote requests", () => {
  it("saves a request as a new client and a quote waiting to be priced", async () => {
    const ctx = makeCtx();
    const response = await requestQuote(ctx, SITE);
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/request/sent");
    const [client] = rows(ctx, "clients");
    const [quote] = rows(ctx, "documents");
    expect(client).toMatchObject({ workspace: "main", name: "Ada Lovelace", email: "ada@example.com" });
    expect(quote).toMatchObject({ workspace: "main", kind: "quote", status: "requested", number: "Q-0141", client_id: client.id, title: "Packaging design" });
    expect(ctx.runtime.state.logs.find((entry) => entry.message === "quote requested")?.metadata).not.toHaveProperty("email");

    // A second request from the same email reuses the client.
    await requestQuote(ctx, SITE, { message: "And labels." });
    expect(rows(ctx, "clients")).toHaveLength(1);
    expect(rows(ctx, "documents").map((row) => row.number)).toEqual(["Q-0141", "Q-0142"]);
  });

  it("silently drops honeypot submissions", async () => {
    const ctx = makeCtx();
    const response = await requestQuote(ctx, SITE, { website: "http://spam.example" });
    expect(response.status).toBe(303);
    expect(rows(ctx, "documents")).toHaveLength(0);
  });

  it("validates input and escapes it when showing the form again", async () => {
    const ctx = makeCtx();
    const response = await requestQuote(ctx, SITE, { name: "<script>alert(1)</script>", email: "not-an-email" });
    expect(response.status).toBe(422);
    const html = await text(response);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("Enter an email address like name@example.com.");
    expect(rows(ctx, "documents")).toHaveLength(0);
  });

  it("refuses posts from other sites and long bodies", async () => {
    const ctx = makeCtx();
    const foreign = post(`${SITE}/request`, { name: "A", email: "a@example.com", service: "web", message: "hi" }, { origin: "https://evil.example" });
    expect((await send(ctx, foreign)).status).toBe(403);
    const long = await requestQuote(ctx, SITE, { message: "x".repeat(2500) });
    expect(long.status).toBe(422);
    expect(rows(ctx, "documents")).toHaveLength(0);
  });

  it("keeps the public page indexable outside the demo", async () => {
    const html = await text(await send(makeCtx(), `${SITE}/`));
    expect(html).not.toContain('name="robots"');
    expect(html).toContain('name="website"');
  });
});

describe("quote to invoice", () => {
  it("prices a quote, shares it, lets the client accept, and converts it to an invoice", async () => {
    const ctx = makeCtx({ user: OWNER });
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace Hopper", company: "Compiler Coffee", email: "grace@example.com", address: "1 Main St" }));
    const client = rows(ctx, "clients")[0];

    const created = await send(
      ctx,
      post(`${SITE}/desk/documents`, {
        kind: "quote",
        client_id: client.id,
        title: "Label system",
        issue_date: "2026-09-01",
        due_date: "",
        tax_percent: "10",
        notes: "Thanks!",
        item_description: ["Label design", "Photography", ""],
        item_quantity: ["2", "1", "1"],
        item_rate: ["1,200", "850.50", ""]
      })
    );
    expect(created.status).toBe(303);
    const quote = rows(ctx, "documents")[0];
    expect(quote).toMatchObject({ kind: "quote", status: "draft", subtotal_cents: 325050, tax_cents: 32505, total_cents: 357555, due_date: "2026-10-01" });
    expect(quote.line_items).toHaveLength(2);

    // Drafts are not visible through the client link.
    expect((await send(ctx, `${SITE}/p/${quote.public_token}`)).status).toBe(404);

    // Owner marks it sent; the client link now works and offers accept/decline.
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    const clientView = await text(await send(ctx, `${SITE}/p/${quote.public_token}`));
    expect(clientView).toContain("Accept quote");
    expect(clientView).toContain("$3,575.55");
    expect(clientView).toContain('content="noindex,nofollow"');

    // Paying an unsent quote is not a valid move.
    const bad = await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "paid" }));
    expect(location(bad)).toContain("done=not-allowed");

    const accepted = await send(ctx, post(`${SITE}/p/${quote.public_token}/respond`, { answer: "accept" }));
    expect(location(accepted)).toBe(`/p/${quote.public_token}?done=accepted`);
    expect(rows(ctx, "documents")[0].status).toBe("accepted");

    const converted = await send(ctx, post(`${SITE}/desk/documents/${quote.id}/convert`, {}));
    const [updatedQuote, invoice] = rows(ctx, "documents");
    expect(location(converted)).toBe(`/desk/documents/${invoice.id}?done=converted`);
    expect(updatedQuote).toMatchObject({ status: "converted", invoice_id: invoice.id });
    expect(invoice).toMatchObject({ kind: "invoice", status: "draft", number: "INV-0231", quote_id: quote.id, total_cents: 357555 });

    // A quote converts once.
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/convert`, {}));
    expect(rows(ctx, "documents")).toHaveLength(2);

    await send(ctx, post(`${SITE}/desk/documents/${invoice.id}/status`, { status: "sent" }));
    await send(ctx, post(`${SITE}/desk/documents/${invoice.id}/status`, { status: "paid" }));
    expect(rows(ctx, "documents")[1]).toMatchObject({ status: "paid" });
    expect(rows(ctx, "documents")[1].paid_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const page = await text(await send(ctx, `${SITE}/desk/documents/${invoice.id}`));
    expect(page).toContain("Paid");
    expect(page).toContain("Label design");
    expect(ctx.runtime.state.logs.map((entry) => entry.message)).toEqual(
      expect.arrayContaining(["quote created", "quote status changed", "quote accepted by client", "quote converted to invoice", "invoice status changed"])
    );
  });

  it("rejects line items without a price and documents for unknown clients", async () => {
    const ctx = makeCtx({ user: OWNER });
    const response = await send(
      ctx,
      post(`${SITE}/desk/documents`, { kind: "invoice", client_id: "clients_404", title: "X", item_description: ["Thing"], item_quantity: ["1"], item_rate: ["lots"] })
    );
    expect(response.status).toBe(422);
    const html = await text(response);
    expect(html).toContain("Choose a client.");
    expect(html).toContain("Check line 1");
    expect(rows(ctx, "documents")).toHaveLength(0);
  });
});

describe("HEAD requests", () => {
  it("answer every page like GET, without a body", async () => {
    const ctx = makeCtx({ user: OWNER });
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace Hopper", email: "grace@example.com" }));
    const client = rows(ctx, "clients")[0];
    await send(ctx, post(`${SITE}/desk/documents`, { kind: "quote", client_id: client.id, title: "Labels", issue_date: "2026-09-01", item_description: ["Label design"], item_quantity: ["1"], item_rate: ["100"] }));
    const quote = rows(ctx, "documents")[0];
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    const pages: Array<[string, number]> = [
      ["/", 200],
      ["/request/sent", 200],
      [`/p/${quote.public_token}`, 200],
      ["/desk", 200],
      ["/desk/new", 200],
      ["/desk/clients", 200],
      [`/desk/clients/${client.id}`, 200],
      [`/desk/documents/${quote.id}`, 200],
      [`/desk/documents/${quote.id}/edit`, 303], // Sent documents are no longer editable.
      ["/missing", 404]
    ];
    for (const [pathname, status] of pages) {
      expect((await expectHeadLikeGet(app, ctx, `${SITE}${pathname}`)).status).toBe(status);
    }
  });

  it("send signed-out visitors to sign in, like GET", async () => {
    const response = await expectHeadLikeGet(app, makeCtx(), `${SITE}/desk?view=invoices`);
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/_userland/auth/login?return_to=%2Fdesk%3Fview%3Dinvoices");
  });

  it("answer the demo like GET, without a body", async () => {
    const ctx = makeCtx();
    for (const pathname of ["/", "/desk"]) {
      expect((await expectHeadLikeGet(app, ctx, `${DEMO}${pathname}`)).status).toBe(200);
    }
  });
});

describe("removing demo mode", () => {
  // Follows the steps in README.md: delete server/demo.js and every line that
  // ends in `// demo`, then checks the app still works with the owner sign-in.
  async function strippedApp() {
    const source = path.resolve(import.meta.dirname, "../server");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-generator-no-demo-"));
    for (const name of fs.readdirSync(source)) {
      if (name === "demo.js") continue;
      const code = fs.readFileSync(path.join(source, name), "utf8");
      const kept = code.split("\n").filter((line) => !/\/\/ demo$/.test(line.trimEnd()));
      fs.writeFileSync(path.join(target, name), kept.join("\n"));
    }
    const stripped = fs.readFileSync(path.join(target, "index.js"), "utf8");
    expect(stripped).not.toContain("demo.");
    const module = await import(pathToFileURL(path.join(target, "index.js")).href);
    return module.default as typeof app;
  }

  it("still serves every page after the demo lines are deleted", async () => {
    const stripped = await strippedApp();
    const visitor = makeCtx();
    const home = await stripped.fetch(new Request(`${DEMO}/`), visitor);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Request a quote");
    expect(html).not.toContain("Demo app");
    expect(html).not.toContain('name="robots"');
    const sent = await stripped.fetch(post(`${DEMO}/request`, { name: "Ada", email: "ada@example.com", service: "web", message: "A site.", website: "" }), visitor);
    expect(location(sent)).toBe("/request/sent");
    expect(rows(visitor, "documents")[0]).toMatchObject({ workspace: "main", status: "requested" });

    // With demo mode gone, even the demo address needs the owner sign-in.
    const gated = await stripped.fetch(new Request(`${DEMO}/desk`), visitor);
    expect(gated.status).toBe(303);
    expect(location(gated)).toContain("/_userland/auth/login");
    expect((await stripped.fetch(post(`${DEMO}/demo/start`, {}), visitor)).status).toBe(404);

    const owner = makeCtx({ user: OWNER });
    const desk = await stripped.fetch(new Request(`${SITE}/desk`), owner);
    expect(desk.status).toBe(200);
    expect((await stripped.fetch(new Request(`${SITE}/nope`), owner)).status).toBe(404);
    await stripped.job({ job_id: "job_1", name: "clear-demo", payload: { workspace: "main" } }, owner);
  });
});

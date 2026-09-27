import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { computeTotals, convertQuote, lineCents, parseMoney, respondToQuote, taxCents, today } from "../server/store.js";
import { expectHeadLikeGet } from "../../../scripts/runtime-harness.js";
import { OWNER, SITE, location, makeCtx, post, requestQuote, row, rows, send, text, type FakeCtx } from "./helpers.js";

// Adds a client and a priced quote as the owner, and returns both rows.
async function pricedQuote(ctx: FakeCtx, fields: Record<string, string | string[]> = {}) {
  await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace Hopper", company: "Compiler Coffee", email: "grace@example.com" }));
  const client = rows(ctx, "clients").find((item) => item.email === "grace@example.com")!;
  const created = await send(
    ctx,
    post(`${SITE}/desk/documents`, { kind: "quote", client_id: client.id, title: "Labels", issue_date: "", item_description: ["Label design"], item_quantity: ["1"], item_rate: ["100"], ...fields })
  );
  const id = location(created).split("/desk/documents/")[1].split("?")[0];
  return { client, quote: row(ctx, "documents", id)! };
}

// Saves a document row directly, for tests that need many of them.
async function seedDocument(ctx: FakeCtx, fields: Record<string, unknown>) {
  return await ctx.data.collection("documents").create({
    workspace: "main",
    kind: "invoice",
    status: "sent",
    client_id: "row_clients_0",
    title: "Seeded",
    issue_date: "2026-01-01",
    due_date: "2099-01-01",
    line_items: [{ description: "Work", quantity: 1, unit_cents: 1000, amount_cents: 1000 }],
    tax_percent: 0,
    subtotal_cents: 1000,
    tax_cents: 0,
    total_cents: 1000,
    currency: "USD",
    notes: "",
    request_message: "",
    public_token: `token_${Math.random().toString(36).slice(2)}_padding`,
    quote_id: "",
    invoice_id: "",
    sent_on: "2026-01-01",
    accepted_on: "",
    paid_on: "",
    ...fields
  });
}

// Makes every data write throw the error Userland returns at a plan's row limit.
function fillStorage(ctx: FakeCtx) {
  const original = ctx.data.collection;
  vi.spyOn(ctx.data, "collection").mockImplementation((name: string) => {
    const collection = original(name);
    const full = async () => {
      throw Object.assign(new Error("Row limit reached."), { code: "quota_exceeded", status: 402 });
    };
    return { ...collection, create: full, update: full };
  });
}

describe("money", () => {
  it("parses prices into cents and computes stored totals", () => {
    expect(parseMoney("1,250.5")).toBe(125050);
    expect(parseMoney("$40")).toBe(4000);
    expect(parseMoney("€40")).toBe(4000);
    expect(parseMoney("£ 12.30")).toBe(1230);
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

  it("rounds exact half cents up, like a spreadsheet", () => {
    // 0.57 × $1.50 = $0.855, and 0.29 × $0.50 = $0.145. Plain floating point gives $0.85 and $0.14.
    expect(lineCents(0.57, 150)).toBe(86);
    expect(lineCents(0.29, 50)).toBe(15);
    expect(lineCents(0.41, 50)).toBe(21);
    expect(lineCents(0.69, 50)).toBe(35);
    expect(lineCents(100000, 100000000)).toBe(10000000000000);
    // 7.5% of $1.00 is 7.5 cents; 8.125% of $10.00 is 81.25 cents.
    expect(taxCents(100, 7.5)).toBe(8);
    expect(taxCents(1000, 8.125)).toBe(81);
    // The largest possible document stays exact.
    expect(taxCents(20 * 10000000000000, 50)).toBe(100000000000000);
  });

  it("stores and shows the rounded amounts", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { quote } = await pricedQuote(ctx, { item_quantity: ["0.57"], item_rate: ["1.50"] });
    expect(quote).toMatchObject({ subtotal_cents: 86, total_cents: 86 });
    const form = await text(await send(ctx, `${SITE}/desk/documents/${quote.id}/edit`));
    expect(form).toContain("0.86");
  });

  it("dates documents in the studio's time zone, not UTC", () => {
    // 10:30 pm in Portland is already the next day in UTC.
    expect(today(new Date("2026-09-28T05:30:00Z"))).toBe("2026-09-27");
    expect(today(new Date("2026-09-28T08:00:00Z"))).toBe("2026-09-28");
  });

  it("prints each document in the currency it was saved with", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { quote } = await pricedQuote(ctx);
    await ctx.data.collection("documents").update(quote.id, { currency: "EUR" });
    const page = await text(await send(ctx, `${SITE}/desk/documents/${quote.id}`));
    expect(page).toContain("€100.00");
    expect(page).not.toContain("$100.00");
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
    const response = await send(ctx, `${SITE}/desk?demo=0tm0y8bAAAAAAAAAAAAAAAA`);
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

describe("cross-site form posts", () => {
  it("refuses desk posts from another site, a sibling Userland app, or a null origin", async () => {
    const ctx = makeCtx({ user: OWNER });
    for (const origin of ["https://evil.example", "https://other-app.apps.userland.fun", "null"]) {
      const response = await send(ctx, post(`${SITE}/desk/clients`, { name: "X", email: "x@example.com" }, { origin }));
      expect(response.status).toBe(403);
    }
    expect(rows(ctx, "clients")).toHaveLength(0);
  });

  it("falls back to Sec-Fetch-Site when Origin is missing, and needs one of them on the desk", async () => {
    const ctx = makeCtx({ user: OWNER });
    const crossSite = await send(ctx, post(`${SITE}/desk/clients`, { name: "X", email: "x@example.com" }, { origin: null, "sec-fetch-site": "same-site" }));
    expect(crossSite.status).toBe(403);
    const neither = await send(ctx, post(`${SITE}/desk/clients`, { name: "X", email: "x@example.com" }, { origin: null }));
    expect(neither.status).toBe(403);
    expect(rows(ctx, "clients")).toHaveLength(0);
    const sameOrigin = await send(ctx, post(`${SITE}/desk/clients`, { name: "X", email: "x@example.com" }, { origin: null, "sec-fetch-site": "same-origin" }));
    expect(sameOrigin.status).toBe(303);
    expect(rows(ctx, "clients")).toHaveLength(1);
  });

  it("caps the body size even without a Content-Length header", async () => {
    const ctx = makeCtx();
    const chunk = new TextEncoder().encode(`message=${"x".repeat(8 * 1024)}&`);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 10) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      }
    });
    const request = new Request(`${SITE}/request`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE },
      // @ts-expect-error Node needs this for a streamed request body.
      duplex: "half"
    });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await send(ctx, request);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(10);
    expect(rows(ctx, "documents")).toHaveLength(0);
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
    expect(quote).toMatchObject({ workspace: "main", kind: "quote", status: "requested", number: "Q-0141", client_id: client.id, title: "Packaging design", request_note: "" });
    expect(ctx.runtime.state.logs.find((entry) => entry.message === "quote requested")?.metadata).not.toHaveProperty("email");

    // A second request from the same email reuses the client.
    await requestQuote(ctx, SITE, { message: "And labels." });
    expect(rows(ctx, "clients")).toHaveLength(1);
    expect(rows(ctx, "documents").map((row) => row.number)).toEqual(["Q-0141", "Q-0142"]);
  });

  it("gives requests that arrive together their own numbers, and one client per email", async () => {
    const ctx = makeCtx();
    const responses = await Promise.all([
      requestQuote(ctx, SITE, { message: "First" }),
      requestQuote(ctx, SITE, { message: "Second" }),
      requestQuote(ctx, SITE, { name: "Other", email: "other@example.com" })
    ]);
    expect(responses.map((response: Response) => response.status)).toEqual([303, 303, 303]);
    const numbers = rows(ctx, "documents").map((row) => row.number);
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.sort()).toEqual(["Q-0141", "Q-0142", "Q-0143"]);
    expect(rows(ctx, "clients").map((client) => client.email).sort()).toEqual(["ada@example.com", "other@example.com"]);
  });

  it("flags a request that uses a known client's email with a different name", async () => {
    const ctx = makeCtx({ user: OWNER });
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace Hopper", company: "Compiler Coffee", email: "grace@example.com" }));
    await requestQuote(ctx, SITE, { name: "Mallory", company: "Not Compiler", email: "grace@example.com" });
    const request = rows(ctx, "documents")[0];
    expect(request.request_note).toContain('"Mallory"');
    const page = await text(await send(ctx, `${SITE}/desk/documents/${request.id}`));
    expect(page).toContain("Check with the client that the request is theirs.");
    expect(page).toContain("Mallory");
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

describe("spam and storage limits", () => {
  it("stops taking requests from one email while three are waiting", async () => {
    const ctx = makeCtx();
    for (const message of ["One", "Two", "Three"]) expect((await requestQuote(ctx, SITE, { message })).status).toBe(303);
    const fourth = await requestQuote(ctx, SITE, { message: "Four" });
    expect(fourth.status).toBe(429);
    expect(await text(fourth)).toContain("You already have 3 requests waiting for a reply.");
    expect(rows(ctx, "documents")).toHaveLength(3);
  });

  it("stops taking requests while 50 are waiting, and says how to reach the studio", async () => {
    const ctx = makeCtx();
    for (let index = 0; index < 50; index += 1) {
      await seedDocument(ctx, { kind: "quote", status: "requested", number: `Q-${String(1000 + index)}`, issue_date: "", due_date: "", line_items: [], total_cents: 0 });
    }
    const response = await requestQuote(ctx, SITE, { email: "new@example.com" });
    expect(response.status).toBe(429);
    const html = await text(response);
    expect(html).toContain("We have more requests than we can answer right now.");
    expect(html).toContain("hello@example.com");
    expect(rows(ctx, "clients")).toHaveLength(0);
  });

  it("keeps the 50-request cap when a bot sends bursts at the same moment, and leaves no extra clients", async () => {
    const ctx = makeCtx();
    let sent = 0;
    for (let burst = 0; burst < 6; burst += 1) {
      const responses = await Promise.all(Array.from({ length: 150 }, () => requestQuote(ctx, SITE, { name: "Bot", email: `bot${sent++}@example.com` })));
      // Refused or asked to try again, never "Something went wrong".
      expect(responses.filter((response: Response) => ![303, 429, 503].includes(response.status))).toEqual([]);
      const pending = rows(ctx, "documents").filter((item) => item.status === "requested");
      expect(pending.length).toBeLessThanOrEqual(50);
      // A refused request takes its new client back out, so every client left has a request.
      expect(rows(ctx, "clients").map((client) => client.id).sort()).toEqual(pending.map((item) => item.client_id).sort());
      expect(new Set(pending.map((item) => item.number)).size).toBe(pending.length);
    }
    // Sent one at a time afterwards, requests fill the cap exactly.
    let late = 0;
    while ((await requestQuote(ctx, SITE, { email: `late${late}@example.com` })).status === 303) late += 1;
    expect(rows(ctx, "documents").filter((item) => item.status === "requested")).toHaveLength(50);
    expect(rows(ctx, "clients")).toHaveLength(50);
  });

  it("keeps one email to three waiting requests when many arrive together", async () => {
    const ctx = makeCtx();
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => requestQuote(ctx, SITE, { message: `Burst ${index}` })));
    expect(responses.filter((response: Response) => ![303, 429, 503].includes(response.status))).toEqual([]);
    const saved = responses.filter((response: Response) => response.status === 303).length;
    expect(saved).toBeLessThanOrEqual(3);
    expect(rows(ctx, "documents")).toHaveLength(saved);
    expect(rows(ctx, "clients").length).toBe(saved > 0 ? 1 : 0);
    // Once the burst is over, the email can still send up to three.
    while (rows(ctx, "documents").length < 3) expect((await requestQuote(ctx, SITE)).status).toBe(303);
    expect((await requestQuote(ctx, SITE)).status).toBe(429);
  });

  it("asks the visitor to send again, and saves nothing, when no free number can be found", async () => {
    const ctx = makeCtx();
    const original = ctx.data.collection;
    vi.spyOn(ctx.data, "collection").mockImplementation((name: string) => {
      const collection = original(name);
      if (name !== "documents") return collection;
      const clash = async () => {
        throw Object.assign(new Error("Unique index by_number already contains this value."), { code: "unique_conflict" });
      };
      return { ...collection, create: clash };
    });
    const response = await requestQuote(ctx, SITE);
    expect(response.status).toBe(503);
    expect(await text(response)).toContain("Please send yours again in a minute.");
    expect(rows(ctx, "clients")).toHaveLength(0);
    expect(rows(ctx, "documents")).toHaveLength(0);
  });

  it("shows a clear message instead of an error when the app's storage is full", async () => {
    const visitor = makeCtx();
    fillStorage(visitor);
    const request = await requestQuote(visitor, SITE);
    expect(request.status).toBe(503);
    expect(await text(request)).toContain("We can&#39;t take new requests online right now.");

    const owner = makeCtx({ user: OWNER });
    fillStorage(owner);
    const add = await send(owner, post(`${SITE}/desk/clients`, { name: "Grace", email: "grace@example.com" }));
    expect(add.status).toBe(503);
    expect(await text(add)).toContain("The app has reached its storage limit.");
  });

  it("lets the owner delete a spam request, and its client when they have nothing else", async () => {
    const ctx = makeCtx({ user: OWNER });
    await requestQuote(ctx, SITE, { name: "Spammer", email: "spam@example.com" });
    const spam = rows(ctx, "documents")[0];
    const page = await text(await send(ctx, `${SITE}/desk/documents/${spam.id}`));
    expect(page).toContain("Delete request and client");
    const deleted = await send(ctx, post(`${SITE}/desk/documents/${spam.id}/delete`, {}));
    expect(location(deleted)).toBe("/desk?done=deleted-with-client");
    expect(rows(ctx, "documents")).toHaveLength(0);
    expect(rows(ctx, "clients")).toHaveLength(0);

    // A client with other documents stays; sent quotes and invoices can't be deleted.
    const { client, quote } = await pricedQuote(ctx);
    await requestQuote(ctx, SITE, { name: "Grace Hopper", email: "grace@example.com" });
    const request = rows(ctx, "documents").find((item) => item.status === "requested")!;
    await send(ctx, post(`${SITE}/desk/documents/${request.id}/delete`, {}));
    expect(row(ctx, "clients", client.id)).toBeDefined();
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    const refused = await send(ctx, post(`${SITE}/desk/documents/${quote.id}/delete`, {}));
    expect(location(refused)).toContain("done=not-allowed");
    expect(row(ctx, "documents", quote.id)).toBeDefined();

    // A client with no documents can be deleted from their page.
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Unused", email: "unused@example.com" }));
    const unused = rows(ctx, "clients").find((item) => item.email === "unused@example.com")!;
    expect(await text(await send(ctx, `${SITE}/desk/clients/${unused.id}`))).toContain("Delete client");
    await send(ctx, post(`${SITE}/desk/clients/${unused.id}/delete`, {}));
    expect(row(ctx, "clients", unused.id)).toBeUndefined();
    const kept = await send(ctx, post(`${SITE}/desk/clients/${client.id}/delete`, {}));
    expect(location(kept)).toContain("done=has-documents");
    expect(row(ctx, "clients", client.id)).toBeDefined();
  });
});

describe("clients", () => {
  it("keeps one client per email, even when two saves arrive together", async () => {
    const ctx = makeCtx({ user: OWNER });
    const responses = await Promise.all([
      send(ctx, post(`${SITE}/desk/clients`, { name: "Grace", email: "grace@example.com" })),
      send(ctx, post(`${SITE}/desk/clients`, { name: "Grace H.", email: "grace@example.com" }))
    ]);
    expect(responses.map((response: Response) => response.status).sort()).toEqual([303, 422]);
    expect(rows(ctx, "clients")).toHaveLength(1);

    await send(ctx, post(`${SITE}/desk/clients`, { name: "Alan", email: "alan@example.com" }));
    const alan = rows(ctx, "clients").find((item) => item.email === "alan@example.com")!;
    const clash = await send(ctx, post(`${SITE}/desk/clients/${alan.id}`, { name: "Alan", email: "grace@example.com" }));
    expect(clash.status).toBe(422);
    expect(await text(clash)).toContain("Another client already uses this email.");
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
    // (Its valid-until date is fixed above, so move it out of the clock's way.)
    await ctx.data.collection("documents").update(quote.id, { due_date: "2099-01-01" });
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

    // A quote converts once; a second try opens the same invoice.
    const again = await send(ctx, post(`${SITE}/desk/documents/${quote.id}/convert`, {}));
    expect(location(again)).toBe(`/desk/documents/${invoice.id}?done=already-converted`);
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

  it("makes one invoice when the convert button is clicked twice at once", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { quote } = await pricedQuote(ctx);
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    const responses = await Promise.all([1, 2, 3].map(() => send(ctx, post(`${SITE}/desk/documents/${quote.id}/convert`, {}))));
    const invoices = rows(ctx, "documents").filter((item) => item.kind === "invoice");
    expect(invoices).toHaveLength(1);
    expect(invoices[0].number).toBe("INV-0231");
    expect(row(ctx, "documents", quote.id)).toMatchObject({ status: "converted", invoice_id: invoices[0].id });
    for (const response of responses) expect(location(response)).toContain(`/desk/documents/${invoices[0].id}?done=`);
  });

  it("removes the extra invoice when a slow second click saves after the first finished", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { quote } = await pricedQuote(ctx);
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    // The second request reads the quote first, but saves its invoice only after the first request is done.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...ctx.data,
      collection(name: string) {
        const collection = ctx.data.collection(name);
        return { ...collection, create: async (input: Record<string, unknown>) => (await gate, await collection.create(input)) };
      }
    };
    const second = convertQuote(slow, "main", quote.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = await convertQuote(ctx.data, "main", quote.id);
    release();
    const late = await second;
    expect(late).toMatchObject({ already: true, invoice: { id: first.invoice.id } });
    expect(rows(ctx, "documents").filter((item) => item.kind === "invoice")).toHaveLength(1);
    expect(row(ctx, "documents", quote.id)).toMatchObject({ status: "converted", invoice_id: first.invoice.id });
  });

  it("keeps the quote converted when the client answers at the same moment", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { quote } = await pricedQuote(ctx);
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    // The client's "accept" is read before the conversion and written after it.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...ctx.data,
      collection(name: string) {
        const collection = ctx.data.collection(name);
        return { ...collection, update: async (id: string, patch: Record<string, unknown>) => (patch.status === "accepted" && (await gate), await collection.update(id, patch)) };
      }
    };
    const answering = respondToQuote(slow, quote.public_token, "accept");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await convertQuote(ctx.data, "main", quote.id)).invoice).toBeTruthy();
    release();
    await answering;
    const invoices = rows(ctx, "documents").filter((item) => item.kind === "invoice");
    expect(invoices).toHaveLength(1);
    expect(row(ctx, "documents", quote.id)).toMatchObject({ status: "converted", invoice_id: invoices[0].id });
    // And it can't be converted again.
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/convert`, {}));
    expect(rows(ctx, "documents").filter((item) => item.kind === "invoice")).toHaveLength(1);
  });

  it("numbers invoices once each when a new invoice and a conversion are saved together", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { client, quote } = await pricedQuote(ctx);
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    const invoice = { kind: "invoice", client_id: client.id, title: "Extra", item_description: ["Thing"], item_quantity: ["1"], item_rate: ["10"] };
    await Promise.all([
      send(ctx, post(`${SITE}/desk/documents`, invoice)),
      send(ctx, post(`${SITE}/desk/documents`, invoice)),
      send(ctx, post(`${SITE}/desk/documents/${quote.id}/convert`, {}))
    ]);
    const numbers = rows(ctx, "documents")
      .filter((item) => item.kind === "invoice")
      .map((item) => item.number)
      .sort();
    expect(numbers).toEqual(["INV-0231", "INV-0232", "INV-0233"]);
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

  it("refuses a due date before the issue date", async () => {
    const ctx = makeCtx({ user: OWNER });
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace", email: "grace@example.com" }));
    const client = rows(ctx, "clients")[0];
    const response = await send(
      ctx,
      post(`${SITE}/desk/documents`, { kind: "invoice", client_id: client.id, title: "X", issue_date: "2026-09-01", due_date: "2020-01-01", item_description: ["Thing"], item_quantity: ["1"], item_rate: ["10"] })
    );
    expect(response.status).toBe(422);
    expect(await text(response)).toContain("Pick a date on or after the first date.");

    // A blank first date means today, so a past due date is refused then too.
    const blank = await send(
      ctx,
      post(`${SITE}/desk/documents`, { kind: "invoice", client_id: client.id, title: "X", issue_date: "", due_date: "2020-01-01", item_description: ["Thing"], item_quantity: ["1"], item_rate: ["10"] })
    );
    expect(blank.status).toBe(422);
    expect(await text(blank)).toContain("Pick a date on or after the first date.");
    expect(rows(ctx, "documents")).toHaveLength(0);

    // Editing a draft: clearing its date also means today.
    const { quote } = await pricedQuote(ctx, { issue_date: "2020-01-01", due_date: "2020-01-05" });
    const edit = await send(ctx, post(`${SITE}/desk/documents/${quote.id}`, { client_id: String(quote.client_id), title: "Labels", issue_date: "", due_date: "2020-01-05", item_description: ["Label design"], item_quantity: ["1"], item_rate: ["100"] }));
    expect(edit.status).toBe(422);
    expect(row(ctx, "documents", quote.id)?.due_date).toBe("2020-01-05");
    expect(row(ctx, "documents", quote.id)?.issue_date).toBe("2020-01-01");
  });
});

describe("client answers and status rules", () => {
  it("doesn't let a client accept a quote after its valid-until date", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { quote } = await pricedQuote(ctx, { issue_date: "2020-01-01", due_date: "2020-01-31" });
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    const view = await text(await send(ctx, `${SITE}/p/${quote.public_token}`));
    expect(view).not.toContain("Accept quote");
    expect(view).toContain("can't be accepted online any more");
    await send(ctx, post(`${SITE}/p/${quote.public_token}/respond`, { answer: "accept" }));
    expect(row(ctx, "documents", quote.id)?.status).toBe("sent");
    expect(await text(await send(ctx, `${SITE}/desk`))).toContain("Expired");
  });

  it("ignores an answer that is neither accept nor decline", async () => {
    const ctx = makeCtx({ user: OWNER });
    const { quote } = await pricedQuote(ctx);
    await send(ctx, post(`${SITE}/desk/documents/${quote.id}/status`, { status: "sent" }));
    for (const fields of [{}, { answer: "" }, { answer: "maybe" }] as Array<Record<string, string>>) {
      const response = await send(ctx, post(`${SITE}/p/${quote.public_token}/respond`, fields));
      expect(location(response)).toBe(`/p/${quote.public_token}`);
    }
    expect(row(ctx, "documents", quote.id)?.status).toBe("sent");
  });

  it("needs priced lines before a request can be sent or invoiced", async () => {
    const ctx = makeCtx({ user: OWNER });
    await requestQuote(ctx, SITE);
    const request = rows(ctx, "documents")[0];
    await send(ctx, post(`${SITE}/desk/documents/${request.id}/status`, { status: "draft" }));
    expect(row(ctx, "documents", request.id)?.status).toBe("draft");
    const page = await text(await send(ctx, `${SITE}/desk/documents/${request.id}`));
    expect(page).not.toContain("Mark as sent");
    expect(page).toContain("Add at least one priced line");
    const refused = await send(ctx, post(`${SITE}/desk/documents/${request.id}/status`, { status: "sent" }));
    expect(location(refused)).toContain("done=needs-lines");
    expect(row(ctx, "documents", request.id)?.status).toBe("draft");
    await send(ctx, post(`${SITE}/desk/documents/${request.id}/convert`, {}));
    expect(rows(ctx, "documents").filter((item) => item.kind === "invoice")).toHaveLength(0);
  });
});

describe("long lists", () => {
  it("totals every invoice and pages through the desk instead of stopping at the first page", async () => {
    const ctx = makeCtx({ user: OWNER });
    for (let index = 0; index < 120; index += 1) {
      await seedDocument(ctx, { number: `INV-${String(1000 + index)}`, issue_date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}` });
    }
    await seedDocument(ctx, { number: "INV-0999", issue_date: "2025-01-01", due_date: "2025-02-01", title: "Oldest overdue" });

    const first = await text(await send(ctx, `${SITE}/desk?view=invoices`));
    expect(first).toContain("121 invoices");
    expect(first).toContain("1 invoice</span>"); // overdue
    expect(first.match(/class="kind-label"/g)).toHaveLength(50);
    const older = first.match(/href="(\/desk\?view=invoices&amp;after=[^"]+)"/)![1].replaceAll("&amp;", "&");

    const second = await text(await send(ctx, `${SITE}${older}`));
    expect(second.match(/class="kind-label"/g)).toHaveLength(50);
    expect(second).toContain("Back to the newest");
    const last = await text(await send(ctx, `${SITE}${second.match(/href="(\/desk\?view=invoices&amp;after=[^"]+)"/)![1].replaceAll("&amp;", "&")}`));
    expect(last.match(/class="kind-label"/g)).toHaveLength(21);
    expect(last).toContain("Oldest overdue");
    expect(last).not.toContain("Older documents");
  });

  it("leaves new requests off the Quotes tab, and still fills every page", async () => {
    const ctx = makeCtx({ user: OWNER });
    const requests = new Set<string>();
    for (let index = 0; index < 70; index += 1) {
      const number = `Q-${String(1000 + index)}`;
      if (index % 7 === 0) requests.add(number);
      // Dated requests sort between the quotes, so skipping them happens mid-page.
      await seedDocument(ctx, { kind: "quote", status: index % 7 === 0 ? "requested" : "sent", number, issue_date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}` });
    }
    const numbers = (html: string) => [...html.matchAll(/>(Q-\d+)<\/a><span class="kind-label">/g)].map((match) => match[1]);
    const first = await text(await send(ctx, `${SITE}/desk?view=quotes`));
    const older = first.match(/href="(\/desk\?view=quotes&amp;after=[^"]+)"/)![1].replaceAll("&amp;", "&");
    const second = await text(await send(ctx, `${SITE}${older}`));
    expect(numbers(first)).toHaveLength(50);
    expect(numbers(second)).toHaveLength(10);
    expect(second).not.toContain("Older documents");
    const shown = [...numbers(first), ...numbers(second)];
    expect(new Set(shown).size).toBe(60);
    expect(shown.filter((number) => requests.has(number))).toEqual([]);
    // The Requests tab still lists them.
    expect(numbers(await text(await send(ctx, `${SITE}/desk?view=requests`))).sort()).toEqual([...requests].sort());
  });

  it("picks the next number after the highest, even with many documents", async () => {
    const ctx = makeCtx({ user: OWNER });
    for (let index = 0; index < 130; index += 1) await seedDocument(ctx, { number: `INV-${String(300 + index).padStart(4, "0")}` });
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace", email: "grace@example.com" }));
    const client = rows(ctx, "clients")[0];
    await send(ctx, post(`${SITE}/desk/documents`, { kind: "invoice", client_id: client.id, title: "Next", item_description: ["Thing"], item_quantity: ["1"], item_rate: ["10"] }));
    expect(rows(ctx, "documents").at(-1)?.number).toBe("INV-0430");
  });

  it("keeps numbering past 9,999", async () => {
    const ctx = makeCtx({ user: OWNER });
    for (const value of [9998, 9999, 10000, 10001, 10002, 10003]) await seedDocument(ctx, { number: `INV-${value}` });
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace", email: "grace@example.com" }));
    const client = rows(ctx, "clients")[0];
    await send(ctx, post(`${SITE}/desk/documents`, { kind: "invoice", client_id: client.id, title: "Next", item_description: ["Thing"], item_quantity: ["1"], item_rate: ["10"] }));
    expect(rows(ctx, "documents").at(-1)?.number).toBe("INV-10004");
  });

  it("pages through clients and a client's documents", async () => {
    const ctx = makeCtx({ user: OWNER });
    for (let index = 0; index < 60; index += 1) {
      await ctx.data.collection("clients").create({ workspace: "main", name: `Client ${String(index).padStart(2, "0")}`, company: "", email: `c${index}@example.com`, address: "", notes: "" });
    }
    const list = await text(await send(ctx, `${SITE}/desk/clients`));
    expect(list).toContain("Client 00");
    expect(list).not.toContain("Client 55");
    const more = list.match(/href="(\/desk\/clients\?after=[^"]+)"/)![1];
    expect(await text(await send(ctx, `${SITE}${more}`))).toContain("Client 55");

    const client = rows(ctx, "clients")[0];
    for (let index = 0; index < 55; index += 1) await seedDocument(ctx, { client_id: client.id, number: `INV-${2000 + index}` });
    const page = await text(await send(ctx, `${SITE}/desk/clients/${client.id}`));
    expect(page.match(/class="col-no"><a/g)).toHaveLength(50);
    expect(page).toContain("Older documents");
    expect(page).not.toContain("Delete client");
  });
});

describe("HEAD requests", () => {
  it("answer every page like GET, without a body", async () => {
    const ctx = makeCtx({ user: OWNER });
    await send(ctx, post(`${SITE}/desk/clients`, { name: "Grace Hopper", email: "grace@example.com" }));
    const client = rows(ctx, "clients")[0];
    await send(ctx, post(`${SITE}/desk/documents`, { kind: "quote", client_id: client.id, title: "Labels", issue_date: "", item_description: ["Label design"], item_quantity: ["1"], item_rate: ["100"] }));
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
});

describe("removing demo mode", () => {
  // Follows the steps in README.md: delete server/demo.js and every line that
  // ends in `// demo`, then checks the app still works with the owner sign-in.
  const DEMO_HOST = "https://invoice-demo.apps.userland.fun";

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
    const home = await stripped.fetch(new Request(`${DEMO_HOST}/`), visitor);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Request a quote");
    expect(html).not.toContain("Demo app");
    expect(html).not.toContain('name="robots"');
    const sent = await stripped.fetch(post(`${DEMO_HOST}/request`, { name: "Ada", email: "ada@example.com", service: "web", message: "A site.", website: "" }), visitor);
    expect(location(sent)).toBe("/request/sent");
    expect(rows(visitor, "documents")[0]).toMatchObject({ workspace: "main", status: "requested" });

    // With demo mode gone, even the demo address needs the owner sign-in.
    const gated = await stripped.fetch(new Request(`${DEMO_HOST}/desk`), visitor);
    expect(gated.status).toBe(303);
    expect(location(gated)).toContain("/_userland/auth/login");
    expect((await stripped.fetch(post(`${DEMO_HOST}/demo/start`, {}), visitor)).status).toBe(404);

    const owner = makeCtx({ user: OWNER });
    const desk = await stripped.fetch(new Request(`${SITE}/desk`), owner);
    expect(desk.status).toBe(200);
    expect((await stripped.fetch(new Request(`${SITE}/nope`), owner)).status).toBe(404);
    await stripped.job({ job_id: "job_1", name: "clear-demo", payload: { workspace: "main" } }, owner);
  });

  it("keeps every other test in this file independent of the demo, so they pass after it is removed", () => {
    const source = fs.readFileSync(import.meta.filename, "utf8");
    const before = source.slice(0, source.indexOf('describe("removing demo mode"'));
    expect(before).not.toMatch(/\bDEMO\b|invoice-demo|demo\.js/);
  });
});

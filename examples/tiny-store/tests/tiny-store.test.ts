import path from "node:path";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest, webhookJobEvent } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
import { deployedRuntime } from "./deployed-runtime.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));
const secrets = { CHECKOUT_SECRET_KEY: "sk_test_checkout_value", CHECKOUT_WEBHOOK_SECRET: "whsec_test_value" };
const admin = { id: "appusr_admin", app_user_id: "appusr_admin", email: "admin@example.test", roles: ["admin"] };
// Open sign-up gives new customers no roles.
const customer = { id: "appusr_ada", app_user_id: "appusr_ada", email: "ada@example.test", roles: [] };
const other = { id: "appusr_bob", app_user_id: "appusr_bob", email: "bob@example.test", roles: [] };

function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://example.test${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function paidEvent(order: { checkout_session_id: string; total_cents: number; currency: string }, overrides: Record<string, unknown> = {}) {
  return webhookJobEvent({
    job: "handle-checkout-event",
    webhook: "checkout",
    body: {
      type: "checkout.completed",
      checkout_session_id: order.checkout_session_id,
      payment_status: "paid",
      amount_total: order.total_cents,
      currency: order.currency.toLowerCase(),
      ...overrides
    }
  });
}

async function storeWithProduct() {
  const runtime = createFakeRuntime(manifest, { secrets, user: admin });
  const created = await app.fetch(post("/api/products", { name: "Mug", slug: "mug", price_cents: 1200, currency: "usd", inventory_count: 5 }), runtime.ctx);
  expect(created.status).toBe(201);
  runtime.setUser(customer);
  return runtime;
}

it("wires the checkout webhook to the job this server handles", () => {
  const resources = manifest.resources as { webhooks: Record<string, { job: string; secret: string }>; secrets: { required: string[] }; jobs: Record<string, unknown> };
  expect(resources.jobs).toHaveProperty(resources.webhooks.checkout.job);
  expect(resources.jobs).toHaveProperty("expire-abandoned-orders");
  expect(resources.secrets.required).toContain(resources.webhooks.checkout.secret);
});

it("only lets admins create products", async () => {
  const runtime = createFakeRuntime(manifest, { secrets, user: customer });
  expect((await app.fetch(post("/api/products", { name: "Mug", slug: "mug", price_cents: 1200 }), runtime.ctx)).status).toBe(403);
});

it("prices orders on the server and never exposes the checkout key", async () => {
  const runtime = await storeWithProduct();
  const response = await app.fetch(post("/api/orders", { line_items: [{ slug: "mug", quantity: 2 }], total_cents: 1 }), runtime.ctx);
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.order).toMatchObject({ status: "checkout_pending", total_cents: 2400, currency: "USD" });

  const exposed = JSON.stringify(body) + JSON.stringify(runtime.state.logs) + JSON.stringify(runtime.state.rows.get("orders"));
  expect(exposed).not.toContain(secrets.CHECKOUT_SECRET_KEY.slice(0, 6));
});

it("requires sign-in to order and hides orders from other customers", async () => {
  const runtime = await storeWithProduct();
  const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();

  runtime.setUser(null);
  expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).status).toBe(401);

  runtime.setUser(other);
  expect((await app.fetch(new Request(`https://example.test/orders/${order.id}`), runtime.ctx)).status).toBe(404);

  runtime.setUser(customer);
  const page = await app.fetch(new Request(`https://example.test/orders/${order.id}`), runtime.ctx);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("USD 12.00");
});

it("marks orders paid from the checkout webhook job exactly once", async () => {
  const runtime = await storeWithProduct();
  const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();

  const delivery = paidEvent(order);
  await app.job(delivery, runtime.ctx);
  await app.job(delivery, runtime.ctx);

  const stored = runtime.state.rows.get("orders")![0]!;
  expect(stored.status).toBe("paid");
  expect(runtime.state.logs.filter((entry) => entry.message === "checkout job processed")).toHaveLength(1);
  // Stock drops once, by the quantity paid for.
  expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
});

describe("checkout events that are not a completed payment", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["an expired checkout", { type: "checkout.expired", payment_status: "unpaid" }],
    ["a failed delayed payment", { type: "checkout.async_payment_failed", payment_status: "unpaid" }],
    ["a completed checkout still waiting on a delayed payment", { payment_status: "unpaid" }],
    ["an event with no type", { type: undefined }]
  ];
  for (const [label, overrides] of cases) {
    it(`leaves the order unpaid for ${label}`, async () => {
      const runtime = await storeWithProduct();
      const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
      await app.job(paidEvent(order, overrides), runtime.ctx);
      expect(runtime.state.rows.get("orders")![0]!.status).toBe("checkout_pending");
      expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(5);
      expect(runtime.state.logs).toContainEqual(expect.objectContaining({ message: "checkout event ignored" }));
    });
  }

  it("leaves the order unpaid when the amount or currency does not match", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
    await app.job(paidEvent(order, { amount_total: 1 }), runtime.ctx);
    await app.job(paidEvent(order, { currency: "eur" }), runtime.ctx);
    expect(runtime.state.rows.get("orders")![0]!.status).toBe("checkout_pending");
    expect(runtime.state.logs.filter((entry) => entry.level === "warn" && entry.message === "checkout amount mismatch")).toHaveLength(2);
  });

  it("warns the owner when a payment arrives for an order that was already cancelled", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
    await runtime.ctx.data.collection("orders").update(order.id, { status: "cancelled" });
    await app.job(paidEvent(order), runtime.ctx);
    expect(runtime.state.rows.get("orders")![0]!.status).toBe("cancelled");
    expect(runtime.state.logs).toContainEqual({ level: "warn", message: "payment received for cancelled order", metadata: { order_id: order.id, webhook_delivery_id: "whd_test_1" } });
  });
});

describe("stock", () => {
  it("refuses orders for more than is in stock, adding up lines for the same product", async () => {
    const runtime = await storeWithProduct();
    const tooMany = await app.fetch(post("/api/orders", { line_items: [{ slug: "mug", quantity: 6 }] }), runtime.ctx);
    expect(tooMany.status).toBe(409);
    expect(await tooMany.json()).toEqual({ error: "out_of_stock", slug: "mug" });
    const split = await app.fetch(post("/api/orders", { line_items: [{ slug: "mug", quantity: 3 }, { slug: "mug", quantity: 3 }] }), runtime.ctx);
    expect(split.status).toBe(409);
    expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "mug", quantity: 5 }] }), runtime.ctx)).status).toBe(201);
  });

  it("shows shoppers whether a product is in stock, not the exact count", async () => {
    const runtime = await storeWithProduct();
    runtime.setUser(admin);
    await app.fetch(post("/api/products", { name: "Bowl", slug: "bowl", price_cents: 900, inventory_count: 0 }), runtime.ctx);
    const { products } = await (await app.fetch(new Request("https://example.test/api/products"), runtime.ctx)).json();
    expect(products.map((product: { slug: string; in_stock: boolean }) => [product.slug, product.in_stock])).toEqual([
      ["bowl", false],
      ["mug", true]
    ]);
    expect(JSON.stringify(products)).not.toContain("inventory_count");
  });

  it("logs a warning instead of going below zero when two paid orders share the last items", async () => {
    const runtime = await storeWithProduct();
    const first = (await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug", quantity: 4 }] }), runtime.ctx)).json()).order;
    const second = (await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug", quantity: 4 }] }), runtime.ctx)).json()).order;
    await app.job(paidEvent(first), runtime.ctx);
    await app.job(paidEvent(second), runtime.ctx);
    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(0);
    expect(runtime.state.logs).toContainEqual(expect.objectContaining({ level: "warn", message: "order oversold", metadata: expect.objectContaining({ order_id: second.id, short_by: 3 }) }));
  });
});

it("expires abandoned checkout orders on the scheduled job", async () => {
  const runtime = await storeWithProduct();
  await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx);
  const [row] = runtime.state.rows.get("orders")!;
  row!.created_at = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  await app.job({ job_id: "job_1", name: "expire-abandoned-orders", payload: {} }, runtime.ctx);
  expect(runtime.state.rows.get("orders")![0]!.status).toBe("cancelled");
});

it("pages past the first 100 pending orders so the oldest ones expire", async () => {
  const runtime = createFakeRuntime(manifest, { secrets, user: customer });
  const orders = runtime.ctx.data.collection("orders");
  // Created first, so least recently updated: these sort onto the last page.
  for (let index = 0; index < 30; index += 1) {
    await orders.create({ app_user_id: customer.app_user_id, status: "checkout_pending", checkout_session_id: `old_${index}` });
  }
  for (let index = 0; index < 120; index += 1) {
    await orders.create({ app_user_id: customer.app_user_id, status: "checkout_pending", checkout_session_id: `new_${index}` });
  }
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  for (const row of runtime.state.rows.get("orders")!) {
    if (String(row.checkout_session_id).startsWith("old_")) row.created_at = old;
  }

  await app.job({ job_id: "job_2", name: "expire-abandoned-orders", payload: {} }, runtime.ctx);

  const rows = runtime.state.rows.get("orders")!;
  expect(rows.filter((row) => row.status === "cancelled")).toHaveLength(30);
  expect(rows.filter((row) => String(row.checkout_session_id).startsWith("new_") && row.status !== "checkout_pending")).toHaveLength(0);
});

describe("posts from other sites", () => {
  const otherApp = "https://attacker.apps.userland.fun";

  it("refuses shop actions posted from another app's page", async () => {
    const runtime = createFakeRuntime(manifest, { secrets, user: admin });
    // A hidden text/plain form on another *.apps.userland.fun app, as in the audit.
    const forged = post("/api/products", '{"name":"x","slug":"cheap","price_cents":1,"z":"="}', { "content-type": "text/plain", origin: otherApp });
    expect((await app.fetch(forged, runtime.ctx)).status).toBe(403);
    expect((await app.fetch(post("/api/products", { name: "x", slug: "cheap", price_cents: 1 }, { origin: "null" }), runtime.ctx)).status).toBe(403);
    expect((await app.fetch(post("/api/product-images", "hi", { "content-type": "text/plain", origin: otherApp }), runtime.ctx)).status).toBe(403);
    runtime.setUser(customer);
    expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "cheap" }] }, { "sec-fetch-site": "cross-site" }), runtime.ctx)).status).toBe(403);
    expect(runtime.state.rows.get("products")).toHaveLength(0);
    expect(runtime.state.files).toHaveLength(0);
  });

  it("accepts the same actions from the shop's own pages", async () => {
    const runtime = createFakeRuntime(manifest, { secrets, user: admin });
    const response = await app.fetch(post("/api/products", { name: "Mug", slug: "mug", price_cents: 1200 }, { origin: "https://example.test", "sec-fetch-site": "same-origin" }), runtime.ctx);
    expect(response.status).toBe(201);
  });

  it("only accepts JSON bodies", async () => {
    const runtime = createFakeRuntime(manifest, { secrets, user: admin });
    expect((await app.fetch(post("/api/products", '{"slug":"mug","price_cents":1}', { "content-type": "text/plain" }), runtime.ctx)).status).toBe(415);
    for (const body of ["{oops", "null", "[]"]) {
      expect((await app.fetch(post("/api/products", body), runtime.ctx)).status).toBe(400);
    }
  });
});

it("answers 409 slug_taken for a duplicate slug, even when two admins save at once", async () => {
  const runtime = deployedRuntime(createFakeRuntime(manifest, { secrets, user: admin }));
  const responses: Response[] = await Promise.all(
    [1, 2, 3].map(() => app.fetch(post("/api/products", { name: "Mug", slug: "mug", price_cents: 1200 }), runtime.ctx))
  );
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
  expect(await responses.find((response) => response.status === 409)!.json()).toEqual({ error: "slug_taken" });
  expect(runtime.state.rows.get("products")).toHaveLength(1);
});

it("limits how many unpaid orders one customer can have open", async () => {
  const runtime = await storeWithProduct();
  for (let index = 0; index < 5; index += 1) {
    expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).status).toBe(201);
  }
  const blocked = await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx);
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ error: "too_many_open_orders", max_open_orders: 5 });

  // Other customers are not affected, and a paid order frees a place.
  runtime.setUser(other);
  expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).status).toBe(201);
  runtime.setUser(customer);
  const [first] = runtime.state.rows.get("orders")!;
  await app.job(paidEvent({ checkout_session_id: String(first!.checkout_session_id), total_cents: 1200, currency: "USD" }), runtime.ctx);
  expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).status).toBe(201);
});

it("pages through every product instead of stopping at the first page", async () => {
  const runtime = createFakeRuntime(manifest, { secrets, user: admin });
  for (let index = 0; index < 120; index += 1) {
    await app.fetch(post("/api/products", { name: `Item ${index}`, slug: `item-${String(index).padStart(3, "0")}`, price_cents: 100, inventory_count: 1 }), runtime.ctx);
  }
  const slugs: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await app.fetch(new Request(`https://example.test/api/products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`), runtime.ctx);
    const body = await response.json();
    slugs.push(...body.products.map((product: { slug: string }) => product.slug));
    cursor = body.cursor;
  } while (cursor);
  expect(slugs).toHaveLength(120);
  expect(new Set(slugs).size).toBe(120);
  expect(slugs[0]).toBe("item-000");
});

it("answers 503 instead of 500 when the checkout key is not set", async () => {
  const runtime = createFakeRuntime(manifest, { secrets: { CHECKOUT_WEBHOOK_SECRET: secrets.CHECKOUT_WEBHOOK_SECRET }, user: admin });
  await app.fetch(post("/api/products", { name: "Mug", slug: "mug", price_cents: 1200, currency: "USD", inventory_count: 5 }), runtime.ctx);
  runtime.setUser(customer);
  const response = await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "checkout_unavailable" });
});

it("answers HEAD on product and order pages like GET, without a body", async () => {
  const runtime = await storeWithProduct();
  const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
  expect((await expectHeadLikeGet(app, runtime.ctx, "https://example.test/api/products")).status).toBe(200);
  expect((await expectHeadLikeGet(app, runtime.ctx, `https://example.test/orders/${order.id}`)).status).toBe(200);
  runtime.setUser(other);
  expect((await expectHeadLikeGet(app, runtime.ctx, `https://example.test/orders/${order.id}`)).status).toBe(404);
});

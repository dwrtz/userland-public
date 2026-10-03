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

type Order = { checkout_session_id: string; total_cents: number; currency: string };

// A Stripe event as the `checkout` webhook hands it to the job: Userland has
// already checked Stripe's signature and drops the Stripe-Signature header.
// The same order gets the same event id unless the test gives another, as when
// Stripe sends one event again.
function stripeEvent(order: Order, session: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  return webhookJobEvent({
    job: "handle-checkout-event",
    webhook: "checkout",
    body: {
      id: `evt_${order.checkout_session_id.replace(/[^A-Za-z0-9]/gu, "")}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: order.checkout_session_id,
          object: "checkout.session",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          amount_total: order.total_cents,
          currency: order.currency.toLowerCase(),
          ...session
        }
      },
      ...event
    }
  });
}

function paidEvent(order: Order, session: Record<string, unknown> = {}) {
  return stripeEvent(order, session);
}

function handledEvents(runtime: { state: { rows: Map<string, Array<Record<string, unknown>>> } }) {
  return (runtime.state.rows.get("handled-events") ?? []).map((row) => row.event_id);
}

async function storeWithProduct() {
  // Deployed behaviour: a unique-index clash throws `unique_conflict`.
  const runtime = deployedRuntime(createFakeRuntime(manifest, { secrets, user: admin }));
  const created = await app.fetch(post("/api/products", { name: "Mug", slug: "mug", price_cents: 1200, currency: "usd", inventory_count: 5 }), runtime.ctx);
  expect(created.status).toBe(201);
  runtime.setUser(customer);
  return runtime;
}

it("wires the checkout webhook to the job this server handles", () => {
  const resources = manifest.resources as { webhooks: Record<string, { provider: string; job: string; secret: string }>; secrets: { required: string[] }; jobs: Record<string, unknown> };
  expect(resources.jobs).toHaveProperty(resources.webhooks.checkout.job);
  expect(resources.jobs).toHaveProperty("expire-abandoned-orders");
  expect(resources.secrets.required).toContain(resources.webhooks.checkout.secret);
  // Stripe sends straight to the app: Userland checks Stripe's own signature with this secret, so there is no relay.
  expect(resources.webhooks.checkout.provider).toBe("stripe");
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

// The hourly job runs while a bank payment is on its way: the checkout
// completed more than 24 hours ago.
async function hoursLater(runtime: { state: { rows: Map<string, Array<Record<string, unknown>>> }; ctx: unknown }, hours: number) {
  const past = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  for (const row of runtime.state.rows.get("orders")!) row.created_at = past;
  await app.job({ job_id: "job_hourly", name: "expire-abandoned-orders", payload: {} }, runtime.ctx);
}

describe("a bank payment, which Stripe confirms days after the checkout completes", () => {
  it("waits for Stripe past the 24 hours the hourly job gives an unpaid checkout, then marks the order paid", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();

    await app.job(stripeEvent(order, { payment_status: "unpaid" }, { id: "evt_completed" }), runtime.ctx);
    expect(runtime.state.rows.get("orders")![0]!.status).toBe("payment_processing");
    expect(runtime.state.logs).toContainEqual({
      level: "info",
      message: "bank payment processing",
      metadata: { order_id: order.id, event_id: "evt_completed", webhook_delivery_id: "whd_test_1" }
    });
    expect(handledEvents(runtime)).toEqual([]);

    // A SEPA debit can take up to 14 business days.
    await hoursLater(runtime, 20 * 24);
    expect(runtime.state.rows.get("orders")![0]!.status).toBe("payment_processing");
    expect(runtime.state.logs).toContainEqual(expect.objectContaining({ message: "abandoned orders expired", metadata: expect.objectContaining({ expired: 0 }) }));

    const confirmed = stripeEvent(order, {}, { id: "evt_confirmed", type: "checkout.session.async_payment_succeeded" });
    await app.job(confirmed, runtime.ctx);
    await app.job(confirmed, runtime.ctx);
    expect(runtime.state.rows.get("orders")![0]!).toMatchObject({ status: "paid", paid_at: expect.any(String) });
    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
    expect(runtime.state.logs.filter((entry) => entry.message === "checkout job processed")).toHaveLength(1);
    expect(handledEvents(runtime)).toEqual(["evt_confirmed"]);
  });

  it("cancels the order when Stripe says the bank payment failed, and takes no stock off", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();

    await app.job(stripeEvent(order, { payment_status: "unpaid" }, { id: "evt_completed" }), runtime.ctx);
    await hoursLater(runtime, 5 * 24);
    await app.job(stripeEvent(order, { payment_status: "unpaid" }, { id: "evt_failed", type: "checkout.session.async_payment_failed" }), runtime.ctx);

    expect(runtime.state.rows.get("orders")![0]!.status).toBe("cancelled");
    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(5);
    expect(runtime.state.logs).toContainEqual({
      level: "info",
      message: "bank payment failed",
      metadata: { order_id: order.id, event_id: "evt_failed", webhook_delivery_id: "whd_test_1" }
    });
    expect(handledEvents(runtime)).toEqual([]);

    // The checkout's own event sent again doesn't bring the order back.
    await app.job(stripeEvent(order, { payment_status: "unpaid" }, { id: "evt_completed" }), runtime.ctx);
    expect(runtime.state.rows.get("orders")![0]!.status).toBe("cancelled");
  });

  it("keeps the order paid when the checkout's own event arrives after Stripe confirmed the payment", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();

    await app.job(stripeEvent(order, {}, { id: "evt_confirmed", type: "checkout.session.async_payment_succeeded" }), runtime.ctx);
    await app.job(stripeEvent(order, { payment_status: "unpaid" }, { id: "evt_completed" }), runtime.ctx);
    await app.job(stripeEvent(order, { payment_status: "unpaid" }, { id: "evt_failed_late", type: "checkout.session.async_payment_failed" }), runtime.ctx);

    expect(runtime.state.rows.get("orders")![0]!.status).toBe("paid");
    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
    expect(runtime.state.logs.filter((entry) => entry.message === "checkout event ignored").map((entry) => entry.metadata?.reason)).toEqual(["status_paid", "status_paid"]);
  });

  it("leaves the order alone when the bank payment's amount or currency does not match", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();

    await app.job(stripeEvent(order, { payment_status: "unpaid", amount_total: 1 }, { id: "evt_completed" }), runtime.ctx);
    await app.job(stripeEvent(order, { payment_status: "unpaid", currency: "eur" }, { id: "evt_failed", type: "checkout.session.async_payment_failed" }), runtime.ctx);

    expect(runtime.state.rows.get("orders")![0]!.status).toBe("checkout_pending");
    expect(runtime.state.logs.filter((entry) => entry.level === "warn" && entry.message === "checkout amount mismatch")).toHaveLength(2);
  });

  it("doesn't count a bank payment on its way as an open checkout", async () => {
    const runtime = await storeWithProduct();
    for (let index = 0; index < 5; index += 1) {
      expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).status).toBe(201);
    }
    const [first] = runtime.state.rows.get("orders")!;
    await app.job(stripeEvent({ checkout_session_id: String(first!.checkout_session_id), total_cents: 1200, currency: "USD" }, { payment_status: "unpaid" }), runtime.ctx);
    expect((await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).status).toBe(201);
  });
});

describe("an event Stripe sends again", () => {
  it("is ignored by its event id once it has been handled, however much later it arrives", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
    const delivery = stripeEvent(order, {}, { id: "evt_1NG8Du2eZvKYlo2CUI79vXWy" });

    await app.job(delivery, runtime.ctx);
    expect(handledEvents(runtime)).toEqual(["evt_1NG8Du2eZvKYlo2CUI79vXWy"]);
    // Userland answers a repeat within 10 minutes itself. A resend from Stripe's dashboard the next day reaches the job.
    await app.job(delivery, runtime.ctx);

    expect(runtime.state.logs).toContainEqual({
      level: "info",
      message: "checkout event ignored",
      metadata: { reason: "already_handled", event_id: "evt_1NG8Du2eZvKYlo2CUI79vXWy", webhook_delivery_id: "whd_test_1" }
    });
    expect(runtime.state.logs.filter((entry) => entry.message === "checkout job processed")).toHaveLength(1);
    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
    expect(handledEvents(runtime)).toEqual(["evt_1NG8Du2eZvKYlo2CUI79vXWy"]);
  });

  it("is not remembered until it has been handled, so a job that failed handles it when retried", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
    const collection = runtime.ctx.data.collection;
    let failOnce = true;
    runtime.ctx.data.collection = ((name: string) => {
      const inner = collection(name);
      if (name !== "orders") return inner;
      return {
        ...inner,
        async update(id: string, patch: Record<string, unknown>) {
          if (failOnce) {
            failOnce = false;
            throw Object.assign(new Error("storage unavailable"), { code: "storage_error", status: 500 });
          }
          return await inner.update(id, patch);
        }
      };
    }) as typeof collection;

    await expect(app.job(paidEvent(order), runtime.ctx)).rejects.toThrow("storage unavailable");
    expect(handledEvents(runtime)).toEqual([]);
    await app.job(paidEvent(order), runtime.ctx);
    expect(runtime.state.rows.get("orders")![0]!.status).toBe("paid");
    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
    expect(handledEvents(runtime)).toHaveLength(1);
  });

  it("takes stock off once when two different events say the same order is paid", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();

    await app.job(stripeEvent(order, {}, { id: "evt_first" }), runtime.ctx);
    await app.job(stripeEvent(order, {}, { id: "evt_second", type: "checkout.session.async_payment_succeeded" }), runtime.ctx);

    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
    expect(runtime.state.logs).toContainEqual(expect.objectContaining({ message: "checkout event ignored", metadata: expect.objectContaining({ reason: "already_paid", event_id: "evt_second" }) }));
    expect(handledEvents(runtime)).toEqual(["evt_first", "evt_second"]);
  });
});

it("takes stock off once when the same payment is delivered twice at the same moment", async () => {
  const runtime = await storeWithProduct();
  const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug", quantity: 2 }] }), runtime.ctx)).json();

  // Count stock writes: the harness can hide a double write when both jobs
  // read the same count, so check the writes themselves.
  const collection = runtime.ctx.data.collection;
  let stockWrites = 0;
  runtime.ctx.data.collection = ((name: string) => {
    const inner = collection(name);
    if (name !== "products") return inner;
    return {
      ...inner,
      async update(id: string, patch: Record<string, unknown>) {
        if ("inventory_count" in patch) stockWrites += 1;
        return await inner.update(id, patch);
      }
    };
  }) as typeof collection;

  const results = await Promise.allSettled([app.job(paidEvent(order), runtime.ctx), app.job(paidEvent(order), runtime.ctx), app.job(paidEvent(order), runtime.ctx)]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  expect(stockWrites).toBe(1);
  expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(3);
  expect(runtime.state.rows.get("orders")![0]!.status).toBe("paid");
  expect(runtime.state.logs.filter((entry) => entry.message === "checkout job processed")).toHaveLength(1);
  // All three copies got past the event id check together; the event is remembered once.
  expect(handledEvents(runtime)).toHaveLength(1);
});

it("still takes stock off when the job is retried after failing once the order was marked paid", async () => {
  const runtime = await storeWithProduct();
  const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
  const collection = runtime.ctx.data.collection;
  let failOnce = true;
  runtime.ctx.data.collection = ((name: string) => {
    const inner = collection(name);
    if (name !== "stock-updates") return inner;
    return {
      ...inner,
      async create(input: Record<string, unknown>) {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("storage unavailable"), { code: "storage_error", status: 500 });
        }
        return await inner.create(input);
      }
    };
  }) as typeof collection;

  await expect(app.job(paidEvent(order), runtime.ctx)).rejects.toThrow("storage unavailable");
  expect(runtime.state.rows.get("orders")![0]!.status).toBe("paid");
  expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(5);

  // The platform retries the job.
  await app.job(paidEvent(order), runtime.ctx);
  expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
  await app.job(paidEvent(order), runtime.ctx);
  expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(4);
});

it("logs an error instead of retrying when stock cannot be updated", async () => {
  const runtime = await storeWithProduct();
  const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
  const collection = runtime.ctx.data.collection;
  runtime.ctx.data.collection = ((name: string) => {
    const inner = collection(name);
    if (name !== "products") return inner;
    return {
      ...inner,
      async update() {
        throw Object.assign(new Error("storage unavailable"), { code: "storage_error", status: 500 });
      }
    };
  }) as typeof collection;

  await app.job(paidEvent(order), runtime.ctx);
  expect(runtime.state.rows.get("orders")![0]!.status).toBe("paid");
  expect(runtime.state.logs).toContainEqual({ level: "error", message: "stock not updated", metadata: { order_id: order.id, code: "storage_error" } });
});

describe("checkout events that are not a completed payment", () => {
  const cases: Array<[string, (order: Order) => ReturnType<typeof stripeEvent>]> = [
    ["an expired checkout", (order) => stripeEvent(order, { status: "expired", payment_status: "unpaid" }, { type: "checkout.session.expired" })],
    ["a confirmed bank payment whose checkout doesn't say paid", (order) => stripeEvent(order, { payment_status: "unpaid" }, { type: "checkout.session.async_payment_succeeded" })],
    ["a completed checkout that needs no payment", (order) => stripeEvent(order, { payment_status: "no_payment_required" })],
    ["an event with no type", (order) => stripeEvent(order, {}, { type: undefined })],
    ["an event about something other than a checkout", (order) => stripeEvent(order, { object: "payment_intent", id: "pi_123", status: "succeeded" }, { type: "payment_intent.succeeded" })],
    ["an event with no checkout in it", (order) => stripeEvent(order, {}, { data: undefined })],
    [
      "the body a relay sent before Stripe could send here directly",
      (order) =>
        webhookJobEvent({
          job: "handle-checkout-event",
          webhook: "checkout",
          body: { type: "checkout.completed", checkout_session_id: order.checkout_session_id, payment_status: "paid", amount_total: order.total_cents, currency: order.currency.toLowerCase() }
        })
    ]
  ];
  for (const [label, delivery] of cases) {
    it(`leaves the order unpaid for ${label}`, async () => {
      const runtime = await storeWithProduct();
      const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
      await app.job(delivery(order), runtime.ctx);
      expect(runtime.state.rows.get("orders")![0]!.status).toBe("checkout_pending");
      expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(5);
      expect(runtime.state.logs).toContainEqual(expect.objectContaining({ message: "checkout event ignored", metadata: expect.objectContaining({ reason: "not_a_completed_payment" }) }));
      expect(handledEvents(runtime)).toEqual([]);
    });
  }

  it("leaves the order unpaid when the checkout has no session id, or one no order has", async () => {
    const runtime = await storeWithProduct();
    const { order } = await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json();
    await app.job(stripeEvent(order, { id: undefined }, { id: "evt_no_session" }), runtime.ctx);
    await app.job(stripeEvent(order, { id: "cs_test_someone_else" }, { id: "evt_other_session" }), runtime.ctx);
    expect(runtime.state.rows.get("orders")![0]!.status).toBe("checkout_pending");
    expect(runtime.state.logs.filter((entry) => entry.level === "warn").map((entry) => entry.message)).toEqual(["checkout event missing session id", "checkout order missing"]);
    expect(handledEvents(runtime)).toEqual([]);
  });

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
    expect(runtime.state.logs).toContainEqual({
      level: "warn",
      message: "payment received for cancelled order",
      metadata: { order_id: order.id, event_id: `evt_${order.checkout_session_id.replace(/[^A-Za-z0-9]/gu, "")}`, webhook_delivery_id: "whd_test_1" }
    });
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

describe("handled Stripe events", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const hourly = { job_id: "job_hourly", name: "expire-abandoned-orders", payload: {} };

  it("are forgotten by the hourly job after 30 days, and an old event sent again takes no stock off", async () => {
    const runtime = await storeWithProduct();
    const first = (await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json()).order;
    const second = (await (await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx)).json()).order;
    const old = stripeEvent(first, {}, { id: "evt_old" });
    await app.job(old, runtime.ctx);
    await app.job(stripeEvent(second, {}, { id: "evt_recent" }), runtime.ctx);
    const rows = runtime.state.rows.get("handled-events")!;
    expect(rows.every((row) => typeof row.handled_at === "string")).toBe(true);
    // The harness keeps each field on the row and in row.data.
    for (const [eventId, days] of [["evt_old", 31], ["evt_recent", 29]] as const) {
      const row = rows.find((candidate) => candidate.event_id === eventId)!;
      row.handled_at = row.data.handled_at = daysAgo(days);
    }

    await app.job(hourly, runtime.ctx);
    expect(handledEvents(runtime)).toEqual(["evt_recent"]);
    expect(runtime.state.logs).toContainEqual({ level: "info", message: "old handled events forgotten", metadata: { forgotten: 1 } });

    // The order is paid already, so its stock-updates row stops the stock going down again.
    await app.job(old, runtime.ctx);
    expect(runtime.state.rows.get("products")![0]!.inventory_count).toBe(3);
    expect(runtime.state.logs).toContainEqual(expect.objectContaining({ message: "checkout event ignored", metadata: expect.objectContaining({ reason: "already_paid", event_id: "evt_old" }) }));
  });

  it("are forgotten at most 500 a run, oldest first", async () => {
    const runtime = createFakeRuntime(manifest, { secrets, user: customer });
    const events = runtime.ctx.data.collection("handled-events");
    for (let index = 0; index < 520; index += 1) {
      await events.create({ event_id: `evt_old_${index}`, handled_at: daysAgo(60 - index / 100) });
    }
    await events.create({ event_id: "evt_kept", handled_at: daysAgo(1) });

    await app.job(hourly, runtime.ctx);
    expect(handledEvents(runtime).sort()).toEqual([...Array.from({ length: 20 }, (_, index) => `evt_old_${500 + index}`), "evt_kept"].sort());
    await app.job(hourly, runtime.ctx);
    expect(handledEvents(runtime)).toEqual(["evt_kept"]);
    expect(runtime.state.logs.filter((entry) => entry.message === "old handled events forgotten").map((entry) => entry.metadata)).toEqual([{ forgotten: 500 }, { forgotten: 20 }]);
  });
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

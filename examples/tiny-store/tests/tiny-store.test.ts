import path from "node:path";
import { createFakeRuntime, readExampleManifest, webhookJobEvent } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));
const secrets = { CHECKOUT_SECRET_KEY: "sk_test_checkout_value", CHECKOUT_WEBHOOK_SECRET: "whsec_test_value" };
const admin = { id: "appusr_admin", app_user_id: "appusr_admin", email: "admin@example.test", roles: ["admin"] };
const customer = { id: "appusr_ada", app_user_id: "appusr_ada", email: "ada@example.test", roles: ["customer"] };
const other = { id: "appusr_bob", app_user_id: "appusr_bob", email: "bob@example.test", roles: ["customer"] };

function post(pathname: string, body: unknown) {
  return new Request(`https://example.test${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

  const delivery = webhookJobEvent({ job: "handle-checkout-event", webhook: "checkout", body: { checkout_session_id: order.checkout_session_id } });
  await app.job(delivery, runtime.ctx);
  await app.job(delivery, runtime.ctx);

  const stored = runtime.state.rows.get("orders")![0]!;
  expect(stored.status).toBe("paid");
  expect(runtime.state.logs.filter((entry) => entry.message === "checkout job processed")).toHaveLength(1);
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

it("answers 503 instead of 500 when the checkout key is not set", async () => {
  const runtime = createFakeRuntime(manifest, { secrets: { CHECKOUT_WEBHOOK_SECRET: secrets.CHECKOUT_WEBHOOK_SECRET }, user: admin });
  await app.fetch(post("/api/products", { name: "Mug", slug: "mug", price_cents: 1200, currency: "USD" }), runtime.ctx);
  runtime.setUser(customer);
  const response = await app.fetch(post("/api/orders", { line_items: [{ slug: "mug" }] }), runtime.ctx);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "checkout_unavailable" });
});

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

function html(body, init = {}) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Tiny Store</title></head><body>${body}</body></html>`, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const ABANDONED_ORDER_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRED_PER_RUN = 500;
const MAX_LINE_ITEMS = 20;
// Each unpaid order is a checkout session at the payment provider, so one
// customer can only have a few open at once. The hourly job cancels unpaid
// orders after 24 hours, which frees the slots up again.
const MAX_OPEN_ORDERS_PER_CUSTOMER = 5;
const MAX_JSON_BYTES = 100_000;
const PAGE_SIZE = 50;
// The only checkout event that marks an order paid. See handleCheckoutEvent.
const PAYMENT_COMPLETED_EVENT = "checkout.completed";

// Shop actions must come from this app's own pages. Userland's sign-in cookie
// is SameSite=Lax and every app on apps.userland.fun counts as the same "site",
// so without this check a page on another app could post a hidden form here
// while an admin or customer is signed in (and, for example, add a product at
// any price). Browsers send an Origin header on every POST (a sandboxed page
// sends "null", which is rejected too). Requests with neither Origin nor
// Sec-Fetch-Site (curl, tests) are not from a browser.
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// Reads a JSON object body. Requiring the JSON content type also stops plain
// HTML forms, which can only send form or text bodies, from reaching the route.
async function readJson(request) {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return { response: json({ error: "json_required" }, { status: 415 }) };
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
    return { response: json({ error: "body_too_large" }, { status: 413 }) };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: json({ error: "invalid_json" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: json({ error: "invalid_json" }, { status: 400 }) };
  }
  return { body };
}

// Returns the signed-in app user or an error response. Checking in app code
// keeps the 401/403 bodies in the same JSON shape as the other errors (an
// uncaught ctx.auth.requireRole error also answers 401 or 403, with the
// platform's own body). Open sign-up gives new customers no roles, so any
// signed-in user may order; only `admin` is checked.
async function signedInUser(request, ctx, role) {
  const user = await ctx.auth.currentUser(request);
  if (!user) {
    return { response: json({ error: "sign_in_required" }, { status: 401 }) };
  }
  if (role && !user.roles.includes(role)) {
    return { response: json({ error: `${role}_role_required` }, { status: 403 }) };
  }
  return { user };
}

function publicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    price_cents: product.price_cents,
    currency: product.currency,
    image_id: product.image_id,
    // Exact stock stays private; shoppers only see whether it can be ordered.
    in_stock: Number(product.inventory_count ?? 0) > 0
  };
}

// One page of active products, sorted by slug. Pass the returned `cursor`
// back as `?cursor=` for the next page; no `cursor` means that was the last.
async function listProducts(ctx, url) {
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && !/^[A-Za-z0-9+/=_-]{1,200}$/u.test(cursor)) {
    return json({ error: "invalid_cursor" }, { status: 400 });
  }
  // `where` and `order_by` fields must be indexed; see the active_products index.
  const page = await ctx.data.collection("products").list({
    where: { status: "active" },
    order_by: [{ field: "slug", direction: "asc" }],
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {})
  });
  return json({ products: page.rows.map(publicProduct), ...(page.cursor ? { cursor: page.cursor } : {}) });
}

async function createProduct(request, ctx) {
  const { response } = await signedInUser(request, ctx, "admin");
  if (response) return response;
  const { body: input, response: invalid } = await readJson(request);
  if (invalid) return invalid;
  const priceCents = Number(input.price_cents);
  const inventoryCount = Number(input.inventory_count ?? 0);
  const slug = String(input.slug ?? "").trim();
  const currency = String(input.currency ?? "USD").toUpperCase();
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(slug) ||
    !Number.isInteger(priceCents) ||
    priceCents < 0 ||
    !Number.isInteger(inventoryCount) ||
    inventoryCount < 0 ||
    !/^[A-Z]{3}$/u.test(currency)
  ) {
    return json({ error: "invalid_product" }, { status: 400 });
  }
  let product;
  try {
    product = await ctx.data.collection("products").create({
      name: String(input.name ?? "Untitled product").slice(0, 200),
      slug,
      description: String(input.description ?? "").slice(0, 20_000),
      price_cents: priceCents,
      currency,
      inventory_count: inventoryCount,
      image_id: String(input.image_id ?? "").slice(0, 200),
      status: input.status === "draft" ? "draft" : "active"
    });
  } catch (error) {
    // The by_slug unique index rejects a second product with the same slug,
    // even when two admins save at the same moment.
    if (error?.code === "unique_conflict") return json({ error: "slug_taken" }, { status: 409 });
    throw error;
  }
  await ctx.log.info("product created", { product_id: product.id });
  return json({ product }, { status: 201 });
}

async function uploadProductImage(request, ctx) {
  const { response } = await signedInUser(request, ctx, "admin");
  if (response) return response;
  const bytes = await request.arrayBuffer();
  // The product-images store only accepts the content types and size declared in the manifest.
  const file = await ctx.files.store("product-images").createUpload(bytes, {
    filename: request.headers.get("x-filename") ?? "product.png",
    content_type: request.headers.get("content-type") ?? "image/png"
  });
  await ctx.log.info("product image uploaded", { file_id: file.file_id });
  return json({ file }, { status: 201 });
}

// Prices and stock come from the products collection, never from the browser.
// Lines for the same product are added together before checking stock.
async function priceLineItems(ctx, requested) {
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_LINE_ITEMS) {
    return { status: 400, error: "invalid_line_items" };
  }
  const quantities = new Map();
  for (const item of requested) {
    const slug = String(item?.slug ?? "");
    const quantity = Number(item?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return { status: 400, error: "invalid_quantity" };
    }
    quantities.set(slug, (quantities.get(slug) ?? 0) + quantity);
  }
  const products = ctx.data.collection("products");
  const lineItems = [];
  let currency = null;
  let totalCents = 0;
  for (const [slug, quantity] of quantities) {
    const match = await products.list({ where: { slug }, limit: 1 });
    const product = match.rows[0];
    if (!product || product.status !== "active") {
      return { status: 400, error: "product_unavailable" };
    }
    if (quantity > Number(product.inventory_count ?? 0)) {
      return { status: 409, error: "out_of_stock", slug: product.slug };
    }
    if (currency && product.currency !== currency) {
      return { status: 400, error: "mixed_currency" };
    }
    currency = product.currency;
    totalCents += product.price_cents * quantity;
    lineItems.push({ product_id: product.id, slug: product.slug, name: product.name, unit_price_cents: product.price_cents, quantity });
  }
  return { lineItems, totalCents, currency };
}

// Counts this customer's unpaid orders through the by_user index, reading
// every page so the count is right however many orders they have.
async function openOrderCount(ctx, appUserId) {
  let open = 0;
  let cursor;
  do {
    const page = await ctx.data.collection("orders").list({ where: { app_user_id: appUserId }, limit: 100, ...(cursor ? { cursor } : {}) });
    open += page.rows.filter((order) => order.status === "checkout_pending").length;
    cursor = page.cursor;
  } while (cursor);
  return open;
}

async function createOrder(request, ctx) {
  const { user, response } = await signedInUser(request, ctx);
  if (response) return response;
  const { body: input, response: invalid } = await readJson(request);
  if (invalid) return invalid;
  const priced = await priceLineItems(ctx, input.line_items);
  if (priced.error) {
    return json({ error: priced.error, ...(priced.slug ? { slug: priced.slug } : {}) }, { status: priced.status });
  }
  // Two orders placed at the same instant can both pass this check, so a
  // customer can end up one or two over the cap; it is a brake, not a lock.
  if ((await openOrderCount(ctx, user.app_user_id)) >= MAX_OPEN_ORDERS_PER_CUSTOMER) {
    return json({ error: "too_many_open_orders", max_open_orders: MAX_OPEN_ORDERS_PER_CUSTOMER }, { status: 429 });
  }

  // A real integration would call the checkout provider here with this key
  // and store the provider's session id. The key stays on the server.
  // `get` returns undefined when the secret is not set, so this can answer a
  // clear 503. `require` would throw instead, and the visitor would get the
  // platform's 400 missing_secret, which reads as if their order was wrong.
  const checkoutKey = await ctx.secrets.get("CHECKOUT_SECRET_KEY");
  if (!checkoutKey) {
    return json({ error: "checkout_unavailable" }, { status: 503 });
  }
  const checkoutSessionId = `mock_checkout_${crypto.randomUUID()}`;

  const order = await ctx.data.collection("orders").create({
    app_user_id: user.app_user_id,
    email: user.email,
    status: "checkout_pending",
    line_items: priced.lineItems,
    total_cents: priced.totalCents,
    currency: priced.currency,
    checkout_session_id: checkoutSessionId
  });
  await ctx.log.info("order created", { order_id: order.id });
  return json({ order: { id: order.id, status: order.status, total_cents: order.total_cents, currency: order.currency, checkout_session_id: checkoutSessionId } }, { status: 201 });
}

async function renderOrder(request, ctx, orderId) {
  const { user, response } = await signedInUser(request, ctx);
  if (response) return response;
  const order = await ctx.data.collection("orders").get(orderId);
  // Only the customer who placed the order, or an admin, can view it.
  if (!order || (order.app_user_id !== user.app_user_id && !user.roles.includes("admin"))) {
    return html("<h1>Order not found</h1>", { status: 404 });
  }
  const total = (Number(order.total_cents ?? 0) / 100).toFixed(2);
  return html(
    `<main><h1>Order ${escapeHtml(order.id)}</h1><p>Status: ${escapeHtml(order.status)}</p><p>Total: ${escapeHtml(order.currency)} ${escapeHtml(total)}</p></main>`
  );
}

// Takes the paid quantities out of stock. Two payments processed at the same
// moment can both read the same count, so stock can end up higher than it
// should; a count that would go below zero is logged as a warning so the
// owner can refund or restock.
async function takeFromStock(ctx, order) {
  const products = ctx.data.collection("products");
  for (const item of Array.isArray(order.line_items) ? order.line_items : []) {
    const product = await products.get(String(item.product_id ?? ""));
    if (!product) {
      await ctx.log.warn("paid product missing", { order_id: order.id, product_id: item.product_id });
      continue;
    }
    const left = Number(product.inventory_count ?? 0) - Number(item.quantity ?? 0);
    if (left < 0) {
      await ctx.log.warn("order oversold", { order_id: order.id, product_id: product.id, short_by: -left });
    }
    await products.update(product.id, { inventory_count: Math.max(0, left) });
  }
}

// The `checkout` webhook delivers verified requests to this job. Userland
// enqueues it with { webhook_delivery_id, name, headers, payload }, where
// `payload` is the parsed request body. The relay must send:
//   { type: "checkout.completed", checkout_session_id, payment_status: "paid",
//     amount_total, currency }
// Only that event marks an order paid, and only when the amount and currency
// match the order. Any other event (expired, failed, still processing) is
// logged and ignored; the hourly job cancels orders that never get paid.
async function handleCheckoutEvent(event, ctx) {
  const delivery = event.payload ?? {};
  const body = delivery.payload && typeof delivery.payload === "object" ? delivery.payload : {};
  const checkoutSessionId = String(body.checkout_session_id ?? "");
  if (!checkoutSessionId) {
    await ctx.log.warn("checkout event missing session id", { webhook_delivery_id: delivery.webhook_delivery_id });
    return;
  }
  if (body.type !== PAYMENT_COMPLETED_EVENT || body.payment_status !== "paid") {
    await ctx.log.info("checkout event ignored", {
      reason: "not_a_completed_payment",
      event_type: String(body.type ?? "").slice(0, 100),
      payment_status: String(body.payment_status ?? "").slice(0, 100),
      webhook_delivery_id: delivery.webhook_delivery_id
    });
    return;
  }
  const orders = ctx.data.collection("orders");
  const match = await orders.list({ where: { checkout_session_id: checkoutSessionId }, limit: 1 });
  const order = match.rows[0];
  if (!order) {
    await ctx.log.warn("checkout order missing", { checkout_session_id: checkoutSessionId });
    return;
  }
  if (body.amount_total !== order.total_cents || String(body.currency ?? "").toUpperCase() !== order.currency) {
    await ctx.log.warn("checkout amount mismatch", { order_id: order.id, webhook_delivery_id: delivery.webhook_delivery_id });
    return;
  }
  if (order.status === "cancelled") {
    // The customer paid after the hourly job gave up on the order. Leave it
    // for the owner to refund or restore by hand.
    await ctx.log.warn("payment received for cancelled order", { order_id: order.id, webhook_delivery_id: delivery.webhook_delivery_id });
    return;
  }
  // Providers retry deliveries; only move pending orders to paid.
  if (order.status !== "checkout_pending") {
    await ctx.log.info("checkout event ignored", { reason: "already_" + order.status, order_id: order.id });
    return;
  }
  await orders.update(order.id, { status: "paid", paid_at: new Date().toISOString() });
  await takeFromStock(ctx, order);
  await ctx.log.info("checkout job processed", { order_id: order.id, webhook_delivery_id: delivery.webhook_delivery_id });
}

// Scheduled hourly by the manifest.
async function expireAbandonedOrders(ctx) {
  const orders = ctx.data.collection("orders");
  const cutoff = Date.now() - ABANDONED_ORDER_MS;

  // Page through every pending order first. The default order is most
  // recently updated first, so the oldest orders are on the last pages.
  // Cursors are positional, so collect ids before changing any status.
  const stale = [];
  let checked = 0;
  let cursor;
  do {
    const page = await orders.list({ where: { status: "checkout_pending" }, limit: 100, ...(cursor ? { cursor } : {}) });
    checked += page.rows.length;
    for (const order of page.rows) {
      if (Date.parse(order.created_at) < cutoff) stale.push(order.id);
    }
    cursor = page.cursor;
  } while (cursor);

  // Cap the writes per run; the next hourly run picks up the rest.
  const batch = stale.slice(0, MAX_EXPIRED_PER_RUN);
  for (const id of batch) {
    await orders.update(id, { status: "cancelled" });
  }
  await ctx.log.info("abandoned orders expired", { checked, expired: batch.length, remaining: stale.length - batch.length });
}

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const app = {
  async fetch(request, ctx) {
    if (request.method === "HEAD") return await answerHead(request, ctx, app.fetch);
    const url = new URL(request.url);

    if (request.method === "POST" && !isSameOrigin(request, url)) {
      return json({ error: "cross_origin_request" }, { status: 403 });
    }

    if (url.pathname === "/api/products" && request.method === "GET") {
      return await listProducts(ctx, url);
    }
    if (url.pathname === "/api/products" && request.method === "POST") {
      return await createProduct(request, ctx);
    }
    if (url.pathname === "/api/product-images" && request.method === "POST") {
      return await uploadProductImage(request, ctx);
    }
    if (url.pathname === "/api/orders" && request.method === "POST") {
      return await createOrder(request, ctx);
    }
    if (url.pathname.startsWith("/orders/") && request.method === "GET") {
      return await renderOrder(request, ctx, url.pathname.slice("/orders/".length));
    }

    return html('<h1>Page not found</h1><p><a href="/">Back to the shop</a></p>', { status: 404 });
  },

  async job(event, ctx) {
    if (event.name === "handle-checkout-event") {
      await handleCheckoutEvent(event, ctx);
    }
    if (event.name === "expire-abandoned-orders") {
      await expireAbandonedOrders(ctx);
    }
  }
};

export default app;

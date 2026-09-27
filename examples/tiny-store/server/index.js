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

// Returns the signed-in app user or an error response. Checking in app code
// keeps 401/403 responses explicit instead of surfacing as a generic 500.
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
    image_id: product.image_id
  };
}

async function listProducts(ctx) {
  // `where` and `order_by` fields must be indexed; see the active_products index.
  const products = await ctx.data.collection("products").list({
    where: { status: "active" },
    order_by: [{ field: "slug", direction: "asc" }],
    limit: 100
  });
  return json({ products: products.rows.map(publicProduct) });
}

async function createProduct(request, ctx) {
  const { response } = await signedInUser(request, ctx, "admin");
  if (response) return response;
  const input = await request.json();
  const priceCents = Number(input.price_cents);
  const inventoryCount = Number(input.inventory_count ?? 0);
  const slug = String(input.slug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(slug) || !Number.isInteger(priceCents) || priceCents < 0 || !Number.isInteger(inventoryCount)) {
    return json({ error: "invalid_product" }, { status: 400 });
  }
  const product = await ctx.data.collection("products").create({
    name: String(input.name ?? "Untitled product").slice(0, 200),
    slug,
    description: String(input.description ?? ""),
    price_cents: priceCents,
    currency: String(input.currency ?? "USD").toUpperCase().slice(0, 3),
    inventory_count: inventoryCount,
    image_id: String(input.image_id ?? ""),
    status: input.status === "draft" ? "draft" : "active"
  });
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

// Prices come from the products collection, never from the browser.
async function priceLineItems(ctx, requested) {
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_LINE_ITEMS) {
    return { error: "invalid_line_items" };
  }
  const products = ctx.data.collection("products");
  const lineItems = [];
  let currency = null;
  let totalCents = 0;
  for (const item of requested) {
    const quantity = Number(item?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return { error: "invalid_quantity" };
    }
    const match = await products.list({ where: { slug: String(item?.slug ?? "") }, limit: 1 });
    const product = match.rows[0];
    if (!product || product.status !== "active") {
      return { error: "product_unavailable" };
    }
    if (currency && product.currency !== currency) {
      return { error: "mixed_currency" };
    }
    currency = product.currency;
    totalCents += product.price_cents * quantity;
    lineItems.push({ product_id: product.id, slug: product.slug, name: product.name, unit_price_cents: product.price_cents, quantity });
  }
  return { lineItems, totalCents, currency };
}

async function createOrder(request, ctx) {
  const { user, response } = await signedInUser(request, ctx);
  if (response) return response;
  const input = await request.json();
  const priced = await priceLineItems(ctx, input.line_items);
  if (priced.error) {
    return json({ error: priced.error }, { status: 400 });
  }

  // A real integration would call the checkout provider here with this key
  // and store the provider's session id. The key stays on the server.
  // `get` returns undefined when the secret is not set, so this can answer 503
  // instead of throwing (a thrown `require` becomes a generic 500).
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

// The `checkout` webhook delivers verified requests to this job. Userland
// enqueues it with { webhook_delivery_id, name, headers, payload }, where
// `payload` is the parsed request body.
async function handleCheckoutEvent(event, ctx) {
  const delivery = event.payload ?? {};
  const body = delivery.payload && typeof delivery.payload === "object" ? delivery.payload : {};
  const checkoutSessionId = String(body.checkout_session_id ?? "");
  if (!checkoutSessionId) {
    await ctx.log.warn("checkout event missing session id", { webhook_delivery_id: delivery.webhook_delivery_id });
    return;
  }
  const orders = ctx.data.collection("orders");
  const match = await orders.list({ where: { checkout_session_id: checkoutSessionId }, limit: 1 });
  const order = match.rows[0];
  if (!order) {
    await ctx.log.warn("checkout order missing", { checkout_session_id: checkoutSessionId });
    return;
  }
  // Providers retry deliveries; only move pending orders to paid.
  if (order.status !== "checkout_pending") {
    await ctx.log.info("checkout event ignored", { order_id: order.id, status: order.status });
    return;
  }
  await orders.update(order.id, { status: "paid", paid_at: new Date().toISOString() });
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

    if (url.pathname === "/api/products" && request.method === "GET") {
      return await listProducts(ctx);
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

    return html("<h1>Tiny Store</h1><p>Browse products and test checkout webhooks.</p>");
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

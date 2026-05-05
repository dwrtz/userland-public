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

async function listProducts(ctx) {
  const products = await ctx.data.collection("products").list({
    where: { status: "active" },
    order_by: [{ field: "slug", direction: "asc" }]
  });
  return json({ products: products.rows });
}

async function createProduct(request, ctx) {
  await ctx.auth.requireRole(request, "admin");
  const input = await request.json();
  const product = await ctx.data.collection("products").create({
    name: String(input.name ?? "Untitled product"),
    slug: String(input.slug ?? "product"),
    description: String(input.description ?? ""),
    price_cents: Number(input.price_cents ?? 0),
    currency: String(input.currency ?? "USD"),
    inventory_count: Number(input.inventory_count ?? 0),
    image_id: String(input.image_id ?? ""),
    status: input.status === "draft" ? "draft" : "active"
  });
  await ctx.log.info("product created", { product_id: product.id });
  return json({ product }, { status: 201 });
}

async function uploadProductImage(request, ctx) {
  await ctx.auth.requireRole(request, "admin");
  const bytes = await request.arrayBuffer();
  const file = await ctx.files.store("product-images").createUpload(bytes, {
    filename: request.headers.get("x-filename") ?? "product.png",
    content_type: request.headers.get("content-type") ?? "image/png"
  });
  return json({ file });
}

async function createOrder(request, ctx) {
  const input = await request.json();
  const checkoutSecret = await ctx.secrets.require("CHECKOUT_SECRET_KEY");
  const checkoutSessionId = `mock_${checkoutSecret.slice(0, 6)}_${Date.now()}`;
  const order = await ctx.data.collection("orders").create({
    app_user_id: String(input.app_user_id ?? ""),
    email: String(input.email ?? ""),
    status: "checkout_pending",
    line_items: input.line_items ?? [],
    total_cents: Number(input.total_cents ?? 0),
    currency: String(input.currency ?? "USD"),
    checkout_session_id: checkoutSessionId,
    paid_at: ""
  });
  await ctx.log.info("order created", { order_id: order.id, checkout_session_id: checkoutSessionId });
  return json({ order }, { status: 201 });
}

async function renderOrder(ctx, orderId) {
  const order = await ctx.data.collection("orders").get(orderId);
  if (!order) {
    return html("<h1>Order not found</h1>", { status: 404 });
  }
  return html(`<main><h1>Order ${order.id}</h1><p>Status: ${order.status}</p><p>Total: ${order.currency} ${Number(order.total_cents ?? 0) / 100}</p></main>`);
}

async function markCheckoutPaid(event, ctx) {
  const checkoutSessionId = String(event.payload.checkout_session_id ?? "");
  const orders = await ctx.data.collection("orders").list({
    where: { checkout_session_id: checkoutSessionId }
  });
  const order = orders.rows[0];
  if (!order) {
    await ctx.log.warn("checkout order missing", { checkout_session_id: checkoutSessionId });
    return;
  }
  await ctx.data.collection("orders").update(order.id, {
    status: "paid",
    paid_at: new Date().toISOString()
  });
  await ctx.log.info("checkout job processed", { order_id: order.id, checkout_session_id: checkoutSessionId });
}

export default {
  async fetch(request, ctx) {
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
      return await renderOrder(ctx, url.pathname.slice("/orders/".length));
    }

    return html("<h1>Tiny Store</h1><p>Browse products and test checkout webhooks.</p>");
  },

  async job(event, ctx) {
    if (event.name === "handle-checkout-event") {
      await markCheckoutPaid(event, ctx);
    }
  }
};

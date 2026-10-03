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
// Each unpaid order is a checkout session at Stripe, so one customer can only
// have a few open at once. The hourly job cancels unpaid orders after 24
// hours, which frees the slots up again.
const MAX_OPEN_ORDERS_PER_CUSTOMER = 5;
const MAX_JSON_BYTES = 100_000;
const PAGE_SIZE = 50;
// The Stripe Checkout events the job acts on; see handleCheckoutEvent. A card
// payment is paid when the session completes. A bank payment (or another
// payment method that takes days) completes unpaid, and Stripe says days later
// whether it went through.
const CHECKOUT_COMPLETED = "checkout.session.completed";
const BANK_PAYMENT_SUCCEEDED = "checkout.session.async_payment_succeeded";
const BANK_PAYMENT_FAILED = "checkout.session.async_payment_failed";
// Stripe event ids look like evt_1NG8Du2eZvKYlo2CUI79vXWy.
const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9_]{1,250}$/u;
// How long the job remembers a Stripe event it has handled. Stripe retries a
// delivery for up to 3 days and lists events for 30, so an older event id
// can't come back; the hourly job forgets older ones so they stop counting
// toward the app's row limit.
const HANDLED_EVENT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FORGOTTEN_PER_RUN = 500;

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

  // A stand-in for Stripe Checkout. A real shop calls Stripe's Checkout
  // Sessions API here with this key (a line for each of priced.lineItems, in
  // priced.currency), stores the session's id (cs_...) as checkout_session_id
  // so the payment event finds this order, and sends the customer to the
  // session's url. The key stays on the server.
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

// Takes the paid quantities out of stock. Two different payments processed at
// the same moment can both read the same count, so stock can end up higher
// than it should; a count that would go below zero is logged as a warning so
// the owner can refund or restock.
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Stripe can send the same event more than once: it retries until it gets an
// answer, and you can resend an event from its dashboard. Userland answers a
// repeat of an event it delivered in the last 10 minutes without passing it
// on. After that, the handled-events collection remembers each event that paid
// an order, and the job ignores it the next time. The hourly job forgets
// events after 30 days; one that came back after that would find its order
// paid already and take no stock off (see the stock-updates row below).
async function alreadyHandled(ctx, eventId) {
  const match = await ctx.data.collection("handled-events").list({ where: { event_id: eventId }, limit: 1 });
  return match.rows.length > 0;
}

// Called once the order is paid and its stock is taken off, so a job that
// fails before then still handles the event when it is retried. The by_event_id
// unique index turns a second copy that got this far at the same moment into
// `unique_conflict`, which means the event is remembered already.
async function rememberHandled(ctx, eventId) {
  if (!eventId) return;
  try {
    await ctx.data.collection("handled-events").create({ event_id: eventId, handled_at: new Date().toISOString() });
  } catch (error) {
    if (error?.code !== "unique_conflict") throw error;
  }
}

// What a Checkout event means for its order, or null when it means nothing
// (an expired checkout, or an event about something else).
function checkoutOutcome(eventType, session) {
  if ((eventType === CHECKOUT_COMPLETED || eventType === BANK_PAYMENT_SUCCEEDED) && session.payment_status === "paid") return "paid";
  // The customer chose a bank payment, which takes days to go through.
  if (eventType === CHECKOUT_COMPLETED && session.payment_status === "unpaid") return "processing";
  if (eventType === BANK_PAYMENT_FAILED) return "failed";
  return null;
}

// The `checkout` webhook is `provider: "stripe"`: Userland checks Stripe's
// signature with CHECKOUT_WEBHOOK_SECRET before anything reaches the app, so
// no relay is needed. It enqueues this job with
// { webhook_delivery_id, name, headers, payload }, where `payload` is Stripe's
// event: { id: "evt_...", type, data: { object: <Checkout Session> } }.
//
// The event's session must be the order's checkout session, with the order's
// amount and currency. Then:
// - A paid checkout.session.completed (a card payment) or
//   checkout.session.async_payment_succeeded marks the order paid.
// - An unpaid checkout.session.completed (a bank payment) moves the order to
//   payment_processing, which the hourly job doesn't cancel, until Stripe says
//   whether the payment went through.
// - checkout.session.async_payment_failed cancels the order.
// Any other event is logged and ignored; the hourly job cancels orders that
// never get paid.
async function handleCheckoutEvent(event, ctx) {
  const delivery = event.payload ?? {};
  const stripeEvent = isObject(delivery.payload) ? delivery.payload : {};
  const eventId = typeof stripeEvent.id === "string" && STRIPE_EVENT_ID.test(stripeEvent.id) ? stripeEvent.id : "";
  const eventType = typeof stripeEvent.type === "string" ? stripeEvent.type : "";
  const session = isObject(stripeEvent.data) && isObject(stripeEvent.data.object) ? stripeEvent.data.object : {};
  const seen = { event_id: eventId, webhook_delivery_id: delivery.webhook_delivery_id };

  if (eventId && (await alreadyHandled(ctx, eventId))) {
    await ctx.log.info("checkout event ignored", { reason: "already_handled", ...seen });
    return;
  }
  const outcome = checkoutOutcome(eventType, session);
  if (!outcome) {
    await ctx.log.info("checkout event ignored", {
      reason: "not_a_completed_payment",
      event_type: eventType.slice(0, 100),
      payment_status: String(session.payment_status ?? "").slice(0, 100),
      ...seen
    });
    return;
  }
  const checkoutSessionId = typeof session.id === "string" ? session.id : "";
  if (!checkoutSessionId) {
    await ctx.log.warn("checkout event missing session id", seen);
    return;
  }
  const orders = ctx.data.collection("orders");
  const match = await orders.list({ where: { checkout_session_id: checkoutSessionId }, limit: 1 });
  const order = match.rows[0];
  if (!order) {
    await ctx.log.warn("checkout order missing", { checkout_session_id: checkoutSessionId.slice(0, 200), ...seen });
    return;
  }
  if (session.amount_total !== order.total_cents || String(session.currency ?? "").toUpperCase() !== order.currency) {
    await ctx.log.warn("checkout amount mismatch", { order_id: order.id, ...seen });
    return;
  }
  if (outcome === "processing") {
    await waitForBankPayment(ctx, order, seen);
  } else if (outcome === "failed") {
    await cancelForFailedPayment(ctx, order, seen);
  } else {
    await markPaid(ctx, order, eventId, seen);
  }
}

// Stripe sends the bank payment's outcome days after the checkout completes,
// so an order that is paid or cancelled already stays as it is: this event was
// sent again, or arrived late.
async function waitForBankPayment(ctx, order, seen) {
  if (order.status !== "checkout_pending") {
    await ctx.log.info("checkout event ignored", { reason: "status_" + order.status, order_id: order.id, ...seen });
    return;
  }
  await ctx.data.collection("orders").update(order.id, { status: "payment_processing" });
  await ctx.log.info("bank payment processing", { order_id: order.id, ...seen });
}

async function cancelForFailedPayment(ctx, order, seen) {
  if (order.status !== "checkout_pending" && order.status !== "payment_processing") {
    await ctx.log.info("checkout event ignored", { reason: "status_" + order.status, order_id: order.id, ...seen });
    return;
  }
  await ctx.data.collection("orders").update(order.id, { status: "cancelled" });
  await ctx.log.info("bank payment failed", { order_id: order.id, ...seen });
}

async function markPaid(ctx, order, eventId, seen) {
  if (order.status === "cancelled") {
    // The customer paid after the order was cancelled, for example by the
    // hourly job. Leave it for the owner to refund or restore by hand.
    await ctx.log.warn("payment received for cancelled order", { order_id: order.id, ...seen });
    return;
  }
  if (order.status !== "checkout_pending" && order.status !== "payment_processing" && order.status !== "paid") {
    await ctx.log.info("checkout event ignored", { reason: "status_" + order.status, order_id: order.id, ...seen });
    return;
  }
  if (order.status !== "paid") {
    await ctx.data.collection("orders").update(order.id, { status: "paid", paid_at: new Date().toISOString() });
  }

  // Stripe retries deliveries, and two deliveries of the same payment can be
  // processed at the same moment. The by_order unique index on stock-updates
  // lets only one of them create this row, so stock is taken off once per
  // order, even for two different events about the same payment. The row is
  // created after the order is marked paid, so a job that failed before this
  // point still takes stock off when it is retried.
  try {
    await ctx.data.collection("stock-updates").create({ order_id: order.id });
  } catch (error) {
    if (error?.code !== "unique_conflict") throw error;
    await ctx.log.info("checkout event ignored", { reason: "already_paid", order_id: order.id, ...seen });
    await rememberHandled(ctx, eventId);
    return;
  }
  try {
    await takeFromStock(ctx, order);
  } catch (error) {
    // Not retried: some lines may already be taken off, and a retry would
    // take them off twice. The owner adjusts stock by hand.
    await ctx.log.error("stock not updated", { order_id: order.id, code: String(error?.code ?? "unknown") });
  }
  await rememberHandled(ctx, eventId);
  await ctx.log.info("checkout job processed", { order_id: order.id, ...seen });
}

// Cancels checkouts left unpaid for 24 hours. Orders waiting on a bank
// payment are payment_processing, not checkout_pending, so they are left for
// Stripe's answer.
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

// Forgets handled Stripe events after 30 days (see HANDLED_EVENT_KEEP_MS), so
// handled-events stays about one row per order paid in the last 30 days.
// Oldest first, through the by_handled_at index, stopping at the first event
// that is still kept.
async function forgetOldEvents(ctx) {
  const events = ctx.data.collection("handled-events");
  const cutoff = Date.now() - HANDLED_EVENT_KEEP_MS;
  const old = [];
  let reachedKept = false;
  let cursor;
  do {
    const page = await events.list({ order_by: [{ field: "handled_at", direction: "asc" }], limit: 100, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) {
      if (old.length >= MAX_FORGOTTEN_PER_RUN || !(Date.parse(row.handled_at) < cutoff)) {
        reachedKept = true;
        break;
      }
      old.push(row.id);
    }
    cursor = page.cursor;
  } while (cursor && !reachedKept);

  // Collected first, since cursors are positional. The next hourly run picks
  // up the rest.
  for (const id of old) {
    await events.delete(id);
  }
  await ctx.log.info("old handled events forgotten", { forgotten: old.length });
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
      await forgetOldEvents(ctx);
    }
  }
};

export default app;

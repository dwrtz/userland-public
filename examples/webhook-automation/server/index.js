function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

async function listEvents(ctx) {
  // Without an `order_by`, rows come back most recently updated first.
  // Return a summary only: stored payloads stay server-side.
  const events = await ctx.data.collection("automation-events").list({ limit: 50 });
  return json({
    events: events.rows.map((row) => ({
      id: row.id,
      external_id: row.external_id,
      status: row.status,
      created_at: row.created_at
    }))
  });
}

// When a manifest webhook uses `deliver_to: "job"`, Userland verifies the
// signature and enqueues the job with this payload:
//   { webhook_delivery_id, name, headers, payload }
// where `payload` is the parsed request body.
async function processAutomationEvent(event, ctx) {
  const delivery = event.payload ?? {};
  const body = delivery.payload && typeof delivery.payload === "object" ? delivery.payload : {};
  const externalId = String(body.external_id ?? delivery.webhook_delivery_id ?? event.job_id);
  const events = ctx.data.collection("automation-events");

  // Webhook providers retry. Skip deliveries that were already processed.
  const existing = await events.list({ where: { external_id: externalId }, limit: 1 });
  if (existing.rows.length > 0) {
    await ctx.log.info("automation event already processed", { automation_event_id: existing.rows[0].id, external_id: externalId });
    return;
  }

  const row = await events.create({
    external_id: externalId,
    status: "processed",
    payload: body
  });
  await ctx.log.info("automation event processed", {
    automation_event_id: row.id,
    external_id: externalId,
    webhook_delivery_id: delivery.webhook_delivery_id
  });
}

export default {
  async fetch(request, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/events" && request.method === "GET") {
      return await listEvents(ctx);
    }
    return new Response("Not found", { status: 404 });
  },

  async job(event, ctx) {
    if (event.name === "process-automation-event") {
      await processAutomationEvent(event, ctx);
    }
  }
};

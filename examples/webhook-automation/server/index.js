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
  const events = await ctx.data.collection("automation-events").list({
    order_by: [{ field: "created_at", direction: "desc" }]
  });
  return json({ events: events.rows });
}

async function processAutomationEvent(event, ctx) {
  const payload = event.payload ?? {};
  const externalId = String(payload.external_id ?? event.id ?? `event_${Date.now()}`);
  const row = await ctx.data.collection("automation-events").create({
    external_id: externalId,
    status: "processed",
    payload
  });
  await ctx.log.info("automation event processed", { automation_event_id: row.id, external_id: externalId });
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


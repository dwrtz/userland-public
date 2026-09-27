// Senders must give every event a stable id of their own. It is how repeats
// are recognized: a retry or a replayed request carries the same id.
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;

// Keep only the fields this automation needs. Everything else in the body is
// dropped rather than stored, so customer details the sender includes do not
// pile up in app data.
function storedFields(body) {
  return {
    type: typeof body.type === "string" ? body.type.slice(0, 100) : null
  };
}

// When a manifest webhook uses `deliver_to: "job"`, Userland verifies the
// signature and enqueues the job with this payload:
//   { webhook_delivery_id, name, headers, payload }
// where `payload` is the parsed request body. `webhook_delivery_id` is new for
// every request Userland receives, including a sender's retry, so it cannot
// be used to spot repeats.
async function processAutomationEvent(event, ctx) {
  const delivery = event.payload ?? {};
  const body = delivery.payload && typeof delivery.payload === "object" && !Array.isArray(delivery.payload) ? delivery.payload : {};
  const externalId = typeof body.external_id === "string" ? body.external_id : "";
  if (!EXTERNAL_ID_PATTERN.test(externalId)) {
    await ctx.log.warn("automation event skipped", { reason: "missing_external_id", webhook_delivery_id: delivery.webhook_delivery_id });
    return;
  }

  // The by_external_id unique index records each event once. A retry, a
  // replay, or two deliveries processed at the same moment all hit the index,
  // and the second one is treated as already done.
  let row;
  try {
    row = await ctx.data.collection("automation-events").create({
      external_id: externalId,
      status: "processed",
      payload: storedFields(body)
    });
  } catch (error) {
    if (error?.code !== "unique_conflict") throw error;
    await ctx.log.info("automation event already processed", { external_id: externalId, webhook_delivery_id: delivery.webhook_delivery_id });
    return;
  }

  // Put side effects (emails, API calls) after the row is created, so each
  // external_id is acted on at most once. If one fails, log it with
  // ctx.log.error and fix it by hand; a retry of the job would skip it.
  await ctx.log.info("automation event processed", {
    automation_event_id: row.id,
    external_id: externalId,
    webhook_delivery_id: delivery.webhook_delivery_id
  });
}

export default {
  // The app has no public routes. Processed events are in the activity log:
  //   userland apps events <app-id> --type runtime.log.info
  async fetch(request) {
    return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  async job(event, ctx) {
    if (event.name === "process-automation-event") {
      await processAutomationEvent(event, ctx);
    }
  }
};

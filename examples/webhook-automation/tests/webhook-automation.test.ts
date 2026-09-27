import path from "node:path";
import { createFakeRuntime, expectHeadLikeGet, readExampleManifest, webhookJobEvent } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
import { deployedRuntime } from "./deployed-runtime.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

function deliver(body: unknown, deliveryId = "whd_test_1") {
  const event = webhookJobEvent({ job: "process-automation-event", webhook: "automation", body });
  // Userland gives every incoming request a new delivery id, retries included.
  event.payload.webhook_delivery_id = deliveryId;
  return event;
}

it("wires the manifest webhook to the job this server handles", () => {
  const resources = manifest.resources as { webhooks: Record<string, { job: string; secret: string }>; secrets: { required: string[] }; jobs: Record<string, unknown> };
  expect(resources.webhooks.automation.job).toBe("process-automation-event");
  expect(resources.jobs).toHaveProperty("process-automation-event");
  expect(resources.secrets.required).toContain(resources.webhooks.automation.secret);
});

it("processes webhook job deliveries into data rows, keeping only the fields it needs", async () => {
  const runtime = createFakeRuntime(manifest);
  await app.job(deliver({ external_id: "provider_1", type: "sync", email: "private@example.test", card: { last4: "4242" } }), runtime.ctx);

  const [row] = runtime.state.rows.get("automation-events")!;
  expect(row).toMatchObject({ external_id: "provider_1", status: "processed", payload: { type: "sync" } });
  expect(JSON.stringify(row)).not.toContain("private@example.test");
  expect(JSON.stringify(row)).not.toContain("4242");
  expect(runtime.state.logs).toContainEqual({
    level: "info",
    message: "automation event processed",
    metadata: { automation_event_id: row!.id, external_id: "provider_1", webhook_delivery_id: "whd_test_1" }
  });
});

it("records a sender's retry of the same event once, even though each retry has a new delivery id", async () => {
  const runtime = deployedRuntime(createFakeRuntime(manifest));
  await app.job(deliver({ external_id: "provider_1" }, "whd_1"), runtime.ctx);
  await app.job(deliver({ external_id: "provider_1" }, "whd_2"), runtime.ctx);
  expect(runtime.state.rows.get("automation-events")).toHaveLength(1);
  expect(runtime.state.logs.filter((entry) => entry.message === "automation event processed")).toHaveLength(1);
  expect(runtime.state.logs).toContainEqual({ level: "info", message: "automation event already processed", metadata: { external_id: "provider_1", webhook_delivery_id: "whd_2" } });
});

it("records simultaneous deliveries of the same event once, without failing the job", async () => {
  const runtime = deployedRuntime(createFakeRuntime(manifest));
  const results = await Promise.allSettled(
    ["whd_1", "whd_2", "whd_3", "whd_4"].map((id) => app.job(deliver({ external_id: "provider_1" }, id), runtime.ctx))
  );
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  expect(runtime.state.rows.get("automation-events")).toHaveLength(1);
  expect(runtime.state.logs.filter((entry) => entry.message === "automation event processed")).toHaveLength(1);
});

it("skips deliveries without a usable external_id instead of recording each retry as new", async () => {
  const runtime = deployedRuntime(createFakeRuntime(manifest));
  for (const body of [{ type: "sync" }, { external_id: 42 }, { external_id: "" }, { external_id: "x".repeat(201) }, null, ["provider_1"]]) {
    await app.job(deliver(body, "whd_retry"), runtime.ctx);
    await app.job(deliver(body, "whd_retry_again"), runtime.ctx);
  }
  expect(runtime.state.rows.get("automation-events")).toHaveLength(0);
  expect(runtime.state.logs.filter((entry) => entry.level === "warn" && entry.message === "automation event skipped")).toHaveLength(12);
});

it("keeps processed events off the public web", async () => {
  const runtime = createFakeRuntime(manifest);
  await app.job(deliver({ external_id: "provider_1", email: "private@example.test" }), runtime.ctx);

  const response = await app.fetch(new Request("https://example.test/api/events"), runtime.ctx);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("provider_1");
});

it("answers HEAD like GET, without a body", async () => {
  const runtime = createFakeRuntime(manifest);
  expect((await expectHeadLikeGet(app, runtime.ctx, "https://example.test/api/events")).status).toBe(404);
});

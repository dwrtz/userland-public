import path from "node:path";
import { createFakeRuntime, readExampleManifest, webhookJobEvent } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const manifest = readExampleManifest(path.resolve(import.meta.dirname, ".."));

function deliver(body: unknown) {
  return webhookJobEvent({ job: "process-automation-event", webhook: "automation", body });
}

it("wires the manifest webhook to the job this server handles", () => {
  const resources = manifest.resources as { webhooks: Record<string, { job: string; secret: string }>; secrets: { required: string[] }; jobs: Record<string, unknown> };
  expect(resources.webhooks.automation.job).toBe("process-automation-event");
  expect(resources.jobs).toHaveProperty("process-automation-event");
  expect(resources.secrets.required).toContain(resources.webhooks.automation.secret);
});

it("processes webhook job deliveries into data rows", async () => {
  const runtime = createFakeRuntime(manifest);
  await app.job(deliver({ external_id: "provider_1", action: "sync" }), runtime.ctx);

  const [row] = runtime.state.rows.get("automation-events")!;
  expect(row).toMatchObject({ external_id: "provider_1", status: "processed", payload: { external_id: "provider_1", action: "sync" } });
  expect(runtime.state.logs).toContainEqual({
    level: "info",
    message: "automation event processed",
    metadata: { automation_event_id: row!.id, external_id: "provider_1", webhook_delivery_id: "whd_test_1" }
  });
});

it("ignores duplicate deliveries for the same external id", async () => {
  const runtime = createFakeRuntime(manifest);
  await app.job(deliver({ external_id: "provider_1" }), runtime.ctx);
  await app.job(deliver({ external_id: "provider_1" }), runtime.ctx);
  expect(runtime.state.rows.get("automation-events")).toHaveLength(1);
});

it("lists event summaries without exposing stored payloads", async () => {
  const runtime = createFakeRuntime(manifest);
  await app.job(deliver({ external_id: "provider_1", email: "private@example.test" }), runtime.ctx);

  const response = await app.fetch(new Request("https://example.test/api/events"), runtime.ctx);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.events).toEqual([expect.objectContaining({ external_id: "provider_1", status: "processed" })]);
  expect(JSON.stringify(body)).not.toContain("private@example.test");
});

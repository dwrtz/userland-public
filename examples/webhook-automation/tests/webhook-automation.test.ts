// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

function makeCtx() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    data: {
      collection(name: string) {
        expect(name).toBe("automation-events");
        return {
          async create(input: Record<string, unknown>) {
            const row = { id: `evt_${rows.length + 1}`, ...input };
            rows.push(row);
            return row;
          },
          async list() {
            return { rows };
          }
        };
      }
    },
    log: {
      info: vi.fn()
    }
  };
}

it("processes webhook job payloads into data rows", async () => {
  const ctx = makeCtx();
  await app.job({ name: "process-automation-event", payload: { external_id: "provider_1", action: "sync" } }, ctx);
  expect(ctx.log.info).toHaveBeenCalledWith("automation event processed", { automation_event_id: "evt_1", external_id: "provider_1" });

  const response = await app.fetch(new Request("https://example.test/api/events"), ctx);
  expect(await response.json()).toEqual({
    events: [{ id: "evt_1", external_id: "provider_1", status: "processed", payload: { external_id: "provider_1", action: "sync" } }]
  });
});

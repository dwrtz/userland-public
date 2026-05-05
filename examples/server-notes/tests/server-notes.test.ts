// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

function makeCtx() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    data: {
      collection(name: string) {
        expect(name).toBe("notes");
        return {
          async create(input: Record<string, unknown>) {
            const row = { id: `note_${rows.length + 1}`, created_at: new Date(0).toISOString(), ...input };
            rows.push(row);
            return row;
          },
          async list() {
            return { rows: rows.filter((row) => row.status === "open") };
          }
        };
      }
    },
    log: {
      info: vi.fn()
    }
  };
}

it("creates and lists notes", async () => {
  const ctx = makeCtx();
  const create = await app.fetch(
    new Request("https://example.test/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: "First", body: "Hello" })
    }),
    ctx
  );
  expect(create.status).toBe(201);
  expect(ctx.log.info).toHaveBeenCalledWith("note created", { note_id: "note_1" });

  const list = await app.fetch(new Request("https://example.test/api/notes"), ctx);
  expect(await list.json()).toEqual({
    notes: [{ id: "note_1", created_at: "1970-01-01T00:00:00.000Z", title: "First", body: "Hello", status: "open" }]
  });
});

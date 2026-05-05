// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

function makeCtx() {
  const state: Record<string, Array<Record<string, unknown>>> = {
    slots: [{ id: "slot_1", title: "Intro call", starts_at: "2026-06-01T16:00:00.000Z", status: "available", booked_by: "" }],
    bookings: []
  };

  const namespace: any = {
    collection(name: string) {
      const rows = state[name];
      if (!rows) throw new Error(`Unknown collection ${name}`);
      return {
        async create(input: Record<string, unknown>) {
          const row = { id: `${name}_${rows.length + 1}`, ...input };
          rows.push(row);
          return row;
        },
        async get(id: string) {
          return rows.find((row) => row.id === id) ?? null;
        },
        async list(options: { where?: Record<string, unknown> } = {}) {
          const where = options.where ?? {};
          return {
            rows: rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
          };
        },
        async update(id: string, patch: Record<string, unknown>) {
          const index = rows.findIndex((row) => row.id === id);
          if (index === -1) throw new Error(`Missing row ${id}`);
          rows[index] = { ...rows[index], ...patch };
          return rows[index];
        }
      };
    },
    async transaction<T>(callback: (tx: typeof namespace) => Promise<T> | T) {
      return await callback(namespace);
    }
  };

  return {
    data: namespace,
    log: {
      info: vi.fn()
    }
  };
}

async function book(ctx: ReturnType<typeof makeCtx>) {
  return await app.fetch(
    new Request("https://example.test/api/bookings", {
      method: "POST",
      body: JSON.stringify({ slot_id: "slot_1", name: "Ada", email: "ada@example.test" })
    }),
    ctx
  );
}

it("claims a slot only once inside a transaction", async () => {
  const ctx = makeCtx();

  const first = await book(ctx);
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({
    booking: { id: "bookings_1", slot_id: "slot_1", status: "confirmed" },
    slot: { id: "slot_1", status: "booked", booked_by: "bookings_1" }
  });

  const second = await book(ctx);
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "slot_unavailable" });

  const available = await app.fetch(new Request("https://example.test/api/slots"), ctx);
  expect(await available.json()).toEqual({ slots: [] });
});

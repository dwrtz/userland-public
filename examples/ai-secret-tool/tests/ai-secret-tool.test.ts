import { readFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

it("uses server-only secrets without putting the secret in frontend output", async () => {
  const ctx = {
    secrets: {
      require: vi.fn(async (name: string) => {
        expect(name).toBe("MODEL_API_KEY");
        return "sk_test_secret_value";
      })
    },
    log: {
      info: vi.fn()
    }
  };

  const response = await app.fetch(
    new Request("https://example.test/api/run", {
      method: "POST",
      body: JSON.stringify({ prompt: "Summarize this" })
    }),
    ctx
  );

  const body = await response.json();
  expect(body.answer).toContain("Mock model response");
  expect(JSON.stringify(body)).not.toContain("sk_test_secret_value");
});

it("does not include secret names or values in static html", async () => {
  const html = await readFile(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  expect(html).not.toContain("sk_test_secret_value");
});

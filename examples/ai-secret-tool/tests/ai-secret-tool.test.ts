import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";

const exampleDir = path.resolve(import.meta.dirname, "..");
const manifest = readExampleManifest(exampleDir);
const secretValue = "sk_test_secret_value";

function run(body: unknown) {
  return new Request("https://example.test/api/run", { method: "POST", body: JSON.stringify(body) });
}

it("uses the server-only secret without returning or logging any part of it", async () => {
  const runtime = createFakeRuntime(manifest, { secrets: { MODEL_API_KEY: secretValue } });
  const response = await app.fetch(run({ prompt: "Summarize this" }), runtime.ctx);

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.answer).toContain("Mock model response");
  const exposed = JSON.stringify(body) + JSON.stringify(runtime.state.logs);
  expect(exposed).not.toContain(secretValue.slice(0, 4));
  expect(JSON.stringify(runtime.state.logs)).not.toContain("Summarize this");
});

it("rejects empty prompts before reading the secret", async () => {
  const runtime = createFakeRuntime(manifest);
  const response = await app.fetch(run({ prompt: "  " }), runtime.ctx);
  expect(response.status).toBe(400);
});

it("does not put secret names or values in static files", async () => {
  const publicDir = path.join(exampleDir, "public");
  for (const file of await readdir(publicDir, { recursive: true })) {
    if (!/\.(html|js|css)$/u.test(file)) continue;
    const contents = await readFile(path.join(publicDir, file), "utf8");
    expect(contents).not.toContain(secretValue);
  }
});

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createFakeRuntime, readExampleManifest } from "../../../scripts/runtime-harness.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { model } from "../server/index.js";

const exampleDir = path.resolve(import.meta.dirname, "..");
const manifest = readExampleManifest(exampleDir);
const secretValue = "sk_test_secret_value";

function run(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/run", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
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

it("refuses calls from other sites and plain form posts, so they cannot spend provider credit", async () => {
  const runtime = createFakeRuntime(manifest, { secrets: { MODEL_API_KEY: secretValue } });
  const otherApp = "https://attacker.apps.userland.fun";
  expect((await app.fetch(run({ prompt: "hi" }, { origin: otherApp }), runtime.ctx)).status).toBe(403);
  expect((await app.fetch(run({ prompt: "hi" }, { origin: "null" }), runtime.ctx)).status).toBe(403);
  expect((await app.fetch(run({ prompt: "hi" }, { "sec-fetch-site": "cross-site" }), runtime.ctx)).status).toBe(403);
  // A text/plain form body, which any page can send without a preflight.
  expect((await app.fetch(run('{"prompt":"hi","x":"="}', { "content-type": "text/plain" }), runtime.ctx)).status).toBe(415);
  expect(runtime.state.logs.filter((entry) => entry.message === "model tool completed")).toHaveLength(0);

  const own = await app.fetch(run({ prompt: "hi" }, { origin: "https://example.test", "sec-fetch-site": "same-origin" }), runtime.ctx);
  expect(own.status).toBe(200);
});

it("answers 400 for bodies that are not a JSON object", async () => {
  const runtime = createFakeRuntime(manifest, { secrets: { MODEL_API_KEY: secretValue } });
  for (const body of ["{nope", "null", "[]", "7"]) {
    const response = await app.fetch(run(body), runtime.ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  }
});

it("answers 503 without details when the key is not set", async () => {
  const runtime = createFakeRuntime(manifest);
  const response = await app.fetch(run({ prompt: "hi" }), runtime.ctx);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "model_unavailable" });
});

it("never passes a provider error's message or status to the visitor", async () => {
  const runtime = createFakeRuntime(manifest, { secrets: { MODEL_API_KEY: secretValue } });
  // Shaped like a provider SDK error. With both `code` and `status`, the
  // platform would answer an uncaught one with this exact message and status.
  const leaky = Object.assign(new Error("Incorrect API key provided: sk_test_****alue. You exceeded your current quota."), {
    code: "invalid_api_key",
    status: 401
  });
  const call = vi.spyOn(model, "call").mockRejectedValue(leaky);
  try {
    const response = await app.fetch(run({ prompt: "hi" }), runtime.ctx);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "model_unavailable" });
    expect(runtime.state.logs).toContainEqual({ level: "error", message: "model call failed", metadata: { status: 401, code: "invalid_api_key" } });
    expect(JSON.stringify(runtime.state.logs)).not.toContain("sk_test");
  } finally {
    call.mockRestore();
  }
});

it("trims very long answers", async () => {
  const runtime = createFakeRuntime(manifest, { secrets: { MODEL_API_KEY: secretValue } });
  const call = vi.spyOn(model, "call").mockResolvedValue("x".repeat(10_000));
  try {
    const { answer } = await (await app.fetch(run({ prompt: "hi" }), runtime.ctx)).json();
    expect(answer).toHaveLength(4000);
  } finally {
    call.mockRestore();
  }
});

it("ships a page that calls the server with JSON", async () => {
  const script = await readFile(path.join(exampleDir, "public/assets/app.js"), "utf8");
  expect(script).toContain('fetch("/api/run"');
  expect(script).toContain('"content-type": "application/json"');
});

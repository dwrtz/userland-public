import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeCommand, type NativeClient } from "../src/native";
import { readNativePackage, NATIVE_PACKAGE_MAX_BYTES } from "../src/nativePackage";

const temporary: string[] = [];
async function packageDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "userland-native-package-")); temporary.push(directory);
  await fs.writeFile(path.join(directory, "wrangler.jsonc"), '// native configuration remains unchanged\n{"name":"example","main":"worker.js","compatibility_date":"2026-10-17",}\n');
  await fs.writeFile(path.join(directory, "worker.js"), "export default { fetch() { return new Response('hello') } };\n");
  return directory;
}
function client() {
  const calls: Array<{ apiPath: string; init: RequestInit; options: unknown }> = [], lines: string[] = [];
  const context: NativeClient = { apiFetch: async <T>(apiPath: string, init: RequestInit, options: unknown) => { calls.push({ apiPath, init, options }); return { operation_id: "nop_1", status: "waiting" } as T; }, pathSegment: (value) => { if (!value || value === "." || value === "..") throw new Error("Invalid path segment"); return encodeURIComponent(value); }, print: (line) => lines.push(line) };
  return { context, calls, lines };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe("native prebuilt packaging", () => {
  it("preserves Cloudflare configuration and UTF-8 source, excluding local dependency and git state", async () => {
    const directory = await packageDir();
    await fs.mkdir(path.join(directory, "assets"));
    await fs.writeFile(path.join(directory, "assets", "index.html"), "<h1>नमस्ते</h1>");
    await fs.mkdir(path.join(directory, "node_modules"));
    await fs.writeFile(path.join(directory, "node_modules", ".env"), "ignored dependency file");
    const result = await readNativePackage(directory);
    expect(result.files["wrangler.jsonc"]).toBe(await fs.readFile(path.join(directory, "wrangler.jsonc"), "utf8"));
    expect(result.files["assets/index.html"]).toBe("<h1>नमस्ते</h1>");
    expect(Object.keys(result.files)).toHaveLength(3);
    expect(Object.hasOwn(result.files, "manifest.userland.json")).toBe(false);
  });
  it.each([".env", ".env.local", ".dev.vars", ".dev.vars.local", ".npmrc", "credentials.json", "service.pem", "service.key", "id_ed25519", "manifest.userland.json"])("rejects private or legacy files: %s", async (filename) => {
    const directory = await packageDir(); await fs.writeFile(path.join(directory, filename), "private");
    await expect(readNativePackage(directory)).rejects.toThrow("Do not include credentials");
  });
  it("rejects private key material under an otherwise ordinary source filename", async () => {
    const directory = await packageDir(); await fs.writeFile(path.join(directory, "innocent.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----");
    await expect(readNativePackage(directory)).rejects.toThrow("Private key material");
  });
  it("rejects file, nested directory and root symlinks", async () => {
    const directory = await packageDir(), outside = await packageDir();
    await fs.symlink(path.join(outside, "worker.js"), path.join(directory, "linked.js"));
    await expect(readNativePackage(directory)).rejects.toThrow("symlinks");
    await fs.unlink(path.join(directory, "linked.js"));
    await fs.symlink(outside, path.join(directory, "linked-folder"), "dir");
    await expect(readNativePackage(directory)).rejects.toThrow("symlinks");
    const rootLink = path.join(outside, "root-link"); await fs.symlink(directory, rootLink, "dir");
    await expect(readNativePackage(rootLink)).rejects.toThrow("not a symlink");
  });
  it("rejects URL-like unsafe filenames, non-UTF8 bytes and binary NULs", async () => {
    const directory = await packageDir(); await fs.writeFile(path.join(directory, "unsafe%2f.js"), "text");
    await expect(readNativePackage(directory)).rejects.toThrow("Unsafe package path");
    await fs.unlink(path.join(directory, "unsafe%2f.js"));
    await fs.writeFile(path.join(directory, "binary.bin"), Buffer.from([0xff, 0xfe]));
    await expect(readNativePackage(directory)).rejects.toThrow("UTF-8 files");
    await fs.writeFile(path.join(directory, "binary.bin"), Buffer.from([0]));
    await expect(readNativePackage(directory)).rejects.toThrow("text files");
  });
  it("enforces total source size and file count before uploading", async () => {
    const directory = await packageDir(); await fs.writeFile(path.join(directory, "large.txt"), "x".repeat(NATIVE_PACKAGE_MAX_BYTES));
    await expect(readNativePackage(directory)).rejects.toThrow("512 KiB");
    await fs.unlink(path.join(directory, "large.txt"));
    await Promise.all(Array.from({ length: 128 }, (_, index) => fs.writeFile(path.join(directory, `${index}.txt`), "x")));
    await expect(readNativePackage(directory)).rejects.toThrow("128 files");
  });
});

describe("native CLI contract", () => {
  it("applies a native prebuilt intent directly and preserves revision/idempotency metadata", async () => {
    const directory = await packageDir(), { context, calls, lines } = client();
    await nativeCommand("apps", ["apply", directory, "--account", "acct_team", "--name", "Example", "--environment", "production", "--mode", "publish", "--audience", "public", "--idempotency-key", "intent-1", "--json"], context);
    expect(calls).toHaveLength(1);
    expect(calls[0].apiPath).toBe("/v1/apps/apply");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ account_id: "acct_team", app: { create: { name: "Example" } }, source: { files: { "worker.js": expect.any(String), "wrangler.jsonc": expect.any(String) } }, target: { environment: "production", mode: "publish", audience: "public" }, idempotency_key: "intent-1" });
    expect(JSON.parse(lines[0])).toMatchObject({ operation_id: "nop_1", status: "waiting" });
    calls.length = 0;
    await nativeCommand("apps", ["apply", directory, "--account", "acct_team", "--app", "app_1", "--expected-revision", "2", "--environment", "preview", "--mode", "preview", "--idempotency-key", "intent-2"], context);
    expect(JSON.parse(String(calls[0].init.body)).app).toEqual({ id: "app_1", expected_revision: 2 });
  });
  it("maps context, precise source reads, get/resume/cancel to the native API", async () => {
    const { context, calls } = client();
    await nativeCommand("context", ["--account", "acct_team", "--cursor", "app_cursor"], context);
    await nativeCommand("apps", ["get", "app_1", "--environment", "preview", "--view", "source", "--source-revision", "src_1", "--path", "worker.js", "--cursor", "8"], context);
    for (const action of ["get", "resume", "cancel"]) await nativeCommand("operations", [action, "nop_1"], context);
    expect(calls.map((call) => `${call.init.method} ${call.apiPath}`)).toEqual(["GET /v1/context?cursor=app_cursor", "GET /v1/apps/app_1?environment=preview&view=source&source_revision=src_1&path=worker.js&cursor=8", "GET /v1/operations/nop_1", "POST /v1/operations/nop_1/resume", "POST /v1/operations/nop_1/cancel"]);
  });
  it("requires explicit Account, intent, environment, mode, update revision and idempotency before calling the API", async () => {
    const directory = await packageDir(), { context, calls } = client();
    const base = ["apply", directory, "--account", "acct_team", "--name", "Example", "--environment", "production", "--mode", "publish", "--idempotency-key", "intent-1"];
    for (const flag of ["--account", "--environment", "--mode", "--idempotency-key"]) {
      const args = [...base], index = args.indexOf(flag); args.splice(index, 2);
      await expect(nativeCommand("apps", args, context)).rejects.toThrow();
    }
    await expect(nativeCommand("apps", [...base, "--app", "app_1"], context)).rejects.toThrow("exactly one");
    await expect(nativeCommand("apps", base.map((entry) => entry === "--name" ? "--app" : entry), context)).rejects.toThrow("expected-revision");
    expect(calls).toEqual([]);
  });
  it("caps JSON-encoded payload size independently from decoded UTF-8 size", async () => {
    const directory = await packageDir(), { context, calls } = client();
    await fs.writeFile(path.join(directory, "worker.js"), '"'.repeat(500 * 1024));
    await expect(nativeCommand("apps", ["apply", directory, "--account", "acct_team", "--name", "Example", "--environment", "production", "--mode", "publish", "--idempotency-key", "intent-1"], context)).rejects.toThrow("768 KiB");
    expect(calls).toEqual([]);
  });
});

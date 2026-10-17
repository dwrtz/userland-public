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
  it("sends a bounded atomic patch without requiring a local package directory", async () => {
    const { context, calls } = client();
    const patch = { base_source_revision: `src_${"a".repeat(64)}`, changes: [{ path: "add.txt", expected_hash: null, content: "new" }, { path: "old.txt", expected_hash: "b".repeat(64), content: null }] };
    await nativeCommand("apps", ["apply", "--account", "acct_team", "--app", "app_1", "--expected-revision", "2", "--environment", "preview", "--mode", "preview", "--patch-json", JSON.stringify(patch), "--idempotency-key", "patch-once"], context);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ app: { id: "app_1", expected_revision: 2 }, source: patch });
  });
  it("promotes an exact artifact with source/config assertions and rejects mixed source intent", async () => {
    const { context, calls } = client();
    const args = ["apply", "--account", "acct_team", "--app", "app_1", "--expected-revision", "2", "--environment", "production", "--mode", "publish", "--build-artifact", "art_exact", "--source-revision", `src_${"a".repeat(64)}`, "--configuration-digest", "b".repeat(64), "--idempotency-key", "promote-once"];
    await nativeCommand("apps", args, context);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ build_artifact_id: "art_exact", source_revision: `src_${"a".repeat(64)}`, configuration_digest: "b".repeat(64) });
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("source");
    await expect(nativeCommand("apps", [...args, "--format", "prebuilt"], context)).rejects.toThrow("promotion cannot replace");
    expect(calls).toHaveLength(1);
  });
  it("preserves explicit source format and generated-secret requirements", async () => {
    const directory = await packageDir(), { context, calls } = client();
    const secrets = [{ name: "SESSION_SIGNING_KEY", ensure: "generated", bytes: 32 }];
    const args = ["apply", directory, "--account", "acct_team", "--name", "Example", "--environment", "preview", "--mode", "preview", "--format", "source", "--secret-requirements-json", JSON.stringify(secrets), "--idempotency-key", "source-intent"];
    await nativeCommand("apps", args, context);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ source: { format: "source" }, secret_requirements: secrets });
    args[args.indexOf("--secret-requirements-json") + 1] = JSON.stringify([{ name: "TOKEN", value: "plaintext" }]);
    await expect(nativeCommand("apps", args, context)).rejects.toThrow("generated secret requirements");
    expect(calls).toHaveLength(1);
  });
  it("runs exact source with literal argv and bounded allocation without an implicit shell", async () => {
    const { context, calls } = client();
    const source = `src_sha256:v1:${"a".repeat(64)}`, argv = ["node", "-e", "console.log('$HOME; $(id)')"];
    await nativeCommand("apps", ["run", "app_1", "--account", "acct_team", "--expected-revision", "4", "--source-revision", source, "--argv-json", JSON.stringify(argv), "--duration-ms", "1000", "--transfer-bytes", "500", "--idempotency-key", "run-once", "--json"], context);
    expect(calls).toHaveLength(1); expect(calls[0].apiPath).toBe("/v1/apps/app_1/runs");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ account_id: "acct_team", expected_revision: 4, source: { source_revision: source }, task: { kind: "command", argv }, limits: { duration_ms: 1000, transfer_bytes: 500 }, idempotency_key: "run-once" });
    expect(calls[0].options).toMatchObject({ accountId: "acct_team", accountScoped: true, raw: true });
  });
  it("selects an exact private preview browser and retrieves declared evidence", async () => {
    const { context, calls } = client();
    const base=["run","app_1","--account","acct_team","--expected-revision","2","--source-revision",`src_${"a".repeat(64)}`,"--argv-json",'["node","test.cjs"]',"--idempotency-key","browser-once"];
    await nativeCommand("apps",[...base,"--deployment","dep_exact","--evidence-paths-json",'["screen.png","trace.zip"]'],context);
    expect(JSON.parse(String(calls[0].init.body)).task).toEqual({kind:"browser",argv:["node","test.cjs"],deployment_id:"dep_exact",evidence_paths:["screen.png","trace.zip"]});
    await nativeCommand("operations",["get","nop_owned","--view","evidence","--path","screen.png","--json"],context);
    expect(calls[1].apiPath).toBe("/v1/operations/nop_owned?view=evidence&path=screen.png");
    for(const extra of [["--evidence-paths-json",'["screen.png"]'],["--deployment","dep_exact","--environment","production"],["--deployment","dep_exact","--evidence-paths-json",'["../screen.png"]'],["--deployment","dep_exact","--evidence-paths-json",'["screen.png","screen.png"]']]) await expect(nativeCommand("apps",[...base,...extra],context)).rejects.toThrow();
    await expect(nativeCommand("operations",["get","nop_owned","--view","evidence"],context)).rejects.toThrow("exact --path");
    expect(calls).toHaveLength(2);
  });
  it("refuses moving source, oversized limits and malformed command arrays locally", async () => {
    const { context, calls } = client();
    const base = ["run", "app_1", "--account", "acct_team", "--expected-revision", "4", "--source-revision", `src_${"a".repeat(64)}`, "--argv-json", '["node","--test"]', "--idempotency-key", "run-once"];
    for (const [flag, value] of [["--source-revision", "latest"], ["--expected-revision", "0"], ["--argv-json", '[]'], ["--argv-json", '[42]']]) {
      const invalid = [...base]; invalid[invalid.indexOf(flag) + 1] = value;
      await expect(nativeCommand("apps", invalid, context)).rejects.toThrow();
    }
    await expect(nativeCommand("apps", [...base, "--duration-ms", "300001"], context)).rejects.toThrow("duration-ms");
    await expect(nativeCommand("apps", [...base, "--transfer-bytes", "67108865"], context)).rejects.toThrow("transfer-bytes");
    expect(calls).toHaveLength(0);
  });
  it("sends declared Playwright checks without an alternate command and selects exact generation logs",async()=>{
    const {context,calls}=client(),verification={files:["tests/essential.spec.cjs"],checks:[{file:"tests/essential.spec.cjs",title:"saves a booking"}]};
    const args=["run","app_1","--account","acct_team","--expected-revision","2","--source-revision",`src_${"a".repeat(64)}`,"--deployment","dep_exact","--verification-json",JSON.stringify(verification),"--idempotency-key","verify-once"];
    await nativeCommand("apps",args,context);expect(JSON.parse(String(calls[0].init.body)).task).toEqual({kind:"browser",deployment_id:"dep_exact",verification});
    await expect(nativeCommand("apps",[...args,"--argv-json",'["node"]'],context)).rejects.toThrow("cannot be combined");
    await nativeCommand("apps",["get","app_1","--environment","preview","--view","logs","--deployment-id","dep_exact"],context);
    expect(calls[1].apiPath).toBe("/v1/apps/app_1?environment=preview&view=logs&deployment_id=dep_exact");
  });
  it("sends exact stop, resume and retention-only delete intent without a second confirmation", async () => {
    const { context, calls } = client();
    await nativeCommand("apps", ["stop", "app_1", "--environment", "preview", "--expected-epoch", "2", "--scope", "suspend", "--idempotency-key", "stop-1"], context);
    await nativeCommand("apps", ["resume", "app_1", "--environment", "preview", "--expected-epoch", "3", "--idempotency-key", "resume-1"], context);
    await nativeCommand("apps", ["delete", "app_1", "--expected-revision", "4", "--retention", "retain_source_and_data", "--idempotency-key", "delete-1"], context);
    expect(calls.map(call => `${call.init.method} ${call.apiPath}`)).toEqual(["POST /v1/apps/app_1/stop", "POST /v1/apps/app_1/resume", "DELETE /v1/apps/app_1"]);
    expect(calls.map(call => JSON.parse(String(call.init.body)))).toEqual([
      { environment: "preview", expected_epoch: 2, scope: "suspend", idempotency_key: "stop-1" },
      { environment: "preview", expected_epoch: 3, idempotency_key: "resume-1" },
      { expected_revision: 4, retention: "retain_source_and_data", idempotency_key: "delete-1" }
    ]);
  });
  it("refuses missing epoch, scope, retention and idempotency intent before a lifecycle request", async () => {
    const { context, calls } = client();
    const stop = ["stop", "app_1", "--environment", "preview", "--expected-epoch", "2", "--scope", "suspend", "--idempotency-key", "stop-1"];
    for (const flag of ["--environment", "--expected-epoch", "--scope", "--idempotency-key"]) {
      const args = [...stop], at = args.indexOf(flag); args.splice(at, 2);
      await expect(nativeCommand("apps", args, context)).rejects.toThrow();
    }
    await expect(nativeCommand("apps", ["resume", "app_1", "--environment", "preview", "--expected-epoch", "0", "--idempotency-key", "x"], context)).rejects.toThrow("positive integer");
    await expect(nativeCommand("apps", ["delete", "app_1", "--expected-revision", "1", "--retention", "purge", "--idempotency-key", "x"], context)).rejects.toThrow("Data purge is not supported");
    expect(calls).toEqual([]);
  });
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
  it("stages JSON-heavy source before an encoded request would exceed the inline limit", async () => {
    const directory = await packageDir(), { context, calls } = client();
    await fs.writeFile(path.join(directory, "worker.js"), '"'.repeat(500 * 1024));
    await nativeCommand("apps", ["apply", directory, "--account", "acct_team", "--name", "Example", "--environment", "production", "--mode", "publish", "--idempotency-key", "intent-1"], context);
    expect(JSON.parse(String(calls[0].init.body)).source).toHaveProperty("manifest");
    expect(Buffer.byteLength(String(calls[0].init.body))).toBeLessThan(768*1024);
    expect(calls.filter(call=>call.init.method==="PUT")).toHaveLength(3);
    expect(calls.at(-1)?.apiPath).toBe("/v1/operations/nop_1/source/commit");
  });
  it("transfers large binary assets as bounded raw bytes while preserving hashes and intent",async()=>{
    const directory=await packageDir(),{context,calls}=client();
    await fs.mkdir(path.join(directory,"assets"));const binary=Buffer.from(Array.from({length:700000},(_,index)=>index%256));
    await fs.writeFile(path.join(directory,"assets","image.png"),binary);
    await nativeCommand("apps",["apply",directory,"--account","acct_team","--name","Example","--environment","preview","--mode","preview","--idempotency-key","binary-once"],context);
    const start=JSON.parse(String(calls[0].init.body));expect(start.source.manifest.find((file:any)=>file.path==="assets/image.png")).toMatchObject({encoding:"binary",bytes:binary.length});expect(start.idempotency_key).toBe("binary-once");
    const parts=calls.filter(call=>call.init.method==="PUT"&&call.apiPath.includes("path=assets%2Fimage.png"));expect(parts).toHaveLength(3);
    expect(Buffer.concat(parts.map(call=>Buffer.from(call.init.body as Uint8Array)))).toEqual(binary);
    expect(parts.every(call=>Buffer.byteLength(call.init.body as Uint8Array)<=256*1024)).toBe(true);
    expect(parts.every(call=>String((call.init.headers as Record<string,string>)["x-userland-sha256"]).startsWith("sha256:v1:"))).toBe(true);
  });
  it("starts a manifest transfer without a local directory",async()=>{
    const {context,calls}=client(),manifest=[{path:"wrangler.jsonc",bytes:2,sha256:"sha256:v1:"+"a".repeat(64),encoding:"utf8"},{path:"worker.js",bytes:1,sha256:"sha256:v1:"+"b".repeat(64),encoding:"utf8"}];
    await nativeCommand("apps",["apply","--manifest-json",JSON.stringify(manifest),"--account","acct_team","--name","Example","--environment","preview","--mode","preview","--idempotency-key","manifest-once"],context);
    expect(JSON.parse(String(calls[0].init.body)).source).toEqual({manifest});
  });
  it("continues the original transfer without a local folder or a second app intent",async()=>{
    const {context,calls}=client(),transfer={action:"put",path:"assets/image.png",part:0,sha256:"sha256:v1:"+"a".repeat(64),base64:"AA=="};
    await nativeCommand("apps",["apply","--account","acct_team","--operation","nop_transfer","--transfer-json",JSON.stringify(transfer)],context);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({account_id:"acct_team",operation_id:"nop_transfer",transfer});
    await expect(nativeCommand("apps",["apply","--account","acct_team","--operation","nop_transfer","--transfer-json",JSON.stringify({action:"commit"}),"--name","Other"],context)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

});

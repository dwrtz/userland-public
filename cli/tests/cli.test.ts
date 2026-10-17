import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

interface RequestRecord {
  method: string;
  url: string;
  authorization: string | undefined;
  accountId: string | undefined;
  /** The JSON body; undefined for a body that isn't JSON (an uploaded file), whose bytes are in rawBody. */
  body: unknown;
  rawBody: Buffer;
  headers: IncomingMessage["headers"];
}

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPackageJsonPath = path.join(repoRoot, "cli", "package.json");
const stdinIsTtyPreload = path.join(repoRoot, "cli", "tests", "fixtures", "stdin-is-tty.mjs");
interface ActivationCase {
  name: string;
  args: string[];
  response: { app_id: string; activation: { status: string } };
  meaning: { live: boolean; serving: string; address_restricted: boolean; missing_secrets: string[] };
  stdout_lines: string[];
}
const activationFixture = JSON.parse(await fs.readFile(path.join(repoRoot, "cli", "tests", "fixtures", "activation-results.json"), "utf8")) as {
  cases: ActivationCase[];
};
const plansArtifact = JSON.parse(await fs.readFile(path.join(repoRoot, "schemas", "plans-v0.json"), "utf8")) as {
  plans: Record<string, { features: Record<string, boolean>; manifest_limits: Record<string, unknown>; release_limits: Record<string, number | null> }>;
};

describe("public CLI", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test("recognizes native secret intent flags before checking required environment",async()=>{
    const result=await runCli(["apps","secrets","set","app_example","TOKEN","--expected-revision","1"],"http://127.0.0.1:1");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Choose --account and --environment");
    expect(result.stderr).not.toContain("Unknown option");
  });

  test.each([
    [["members", "list", "--account", "acct_team"], "GET /v0/accounts/acct_team/members", "acct_team", undefined],
    [["members", "invite", "member@example.com", "--role", "member", "--account", "acct_team"], "POST /v0/accounts/acct_team/invitations", "acct_team", { email: "member@example.com", role: "member" }],
    [["members", "role", "usr_member", "--role", "viewer", "--account", "acct_team"], "PATCH /v0/accounts/acct_team/members/usr_member", "acct_team", { role: "viewer" }],
    [["members", "remove", "usr_member", "--yes", "--account", "acct_team"], "DELETE /v0/accounts/acct_team/members/usr_member", "acct_team", undefined],
    [["invitations", "list"], "GET /v0/account-invitations", undefined, undefined],
    [["invitations", "accept", "acinv_1"], "POST /v0/account-invitations/acinv_1/accept", undefined, undefined],
    [["invitations", "revoke", "acinv_1", "--yes", "--account", "acct_team"], "DELETE /v0/accounts/acct_team/invitations/acinv_1", "acct_team", undefined]
  ] as const)("Account membership command %j calls the supported administration API", async (args, route, accountId, body) => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { [route]: { account_id: "acct_team", members: [], invitations: [], member_capacity: 3, invitation: { id: "acinv_1", expires_at: "2026-10-24T12:00:00.000Z" }, notification_status: "sent" } });
    const result = await runCli(["accounts", ...args, "--json"], api.baseUrl, { accountId: "acct_previous" });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ account_id: "acct_team" });
    expect(requests).toHaveLength(1);
    expect(`${requests[0].method} ${requests[0].url}`).toBe(route);
    expect(requests[0].accountId).toBe(accountId);
    expect(requests[0].authorization).toBe("Bearer test_api_key");
    expect(requests[0].body).toEqual(body);
  });

  test("Account membership command resolves the default Account before acting", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/members": { account_id: "acct_owner", members: [], invitations: [], member_capacity: 3 }
    });
    const result = await runCli(["accounts", "members", "list", "--json"], api.baseUrl);
    expect(result.code, result.stderr).toBe(0);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/accounts", "GET /v0/accounts/acct_owner/members"]);
    expect(requests[1].accountId).toBe("acct_owner");
  });

  test.each([
    [["context", "--cursor", "app_cursor"], "GET /v1/context?cursor=app_cursor"],
    [["apps", "get", "app_native", "--environment", "preview", "--view", "source", "--source-revision", "src_exact", "--path", "worker.js", "--cursor", "8"], "GET /v1/apps/app_native?environment=preview&view=source&source_revision=src_exact&path=worker.js&cursor=8"],
    [["apps", "stop", "app_native", "--environment", "preview", "--expected-epoch", "1", "--scope", "suspend", "--idempotency-key", "stop-native"], "POST /v1/apps/app_native/stop"],
    [["apps", "resume", "app_native", "--environment", "preview", "--expected-epoch", "2", "--idempotency-key", "resume-native"], "POST /v1/apps/app_native/resume"],
    [["apps", "delete", "app_native", "--expected-revision", "1", "--retention", "retain_source_and_data", "--idempotency-key", "delete-native"], "DELETE /v1/apps/app_native"],
    [["operations", "get", "nop_native"], "GET /v1/operations/nop_native"],
    [["operations", "resume", "nop_native"], "POST /v1/operations/nop_native/resume"],
    [["operations", "cancel", "nop_native"], "POST /v1/operations/nop_native/cancel"]
  ] as const)("Native Worker command %j calls the exact API contract", async (args, route) => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { [route]: { operation_id: "nop_native", status: "waiting" } });
    const result = await runCli([...args, "--account", "acct_team", "--json"], api.baseUrl, { accountId: "acct_previous" });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ operation_id: "nop_native" });
    expect(requests).toHaveLength(1);
    expect(`${requests[0].method} ${requests[0].url}`).toBe(route);
    expect(requests[0].accountId).toBe("acct_team");
    expect(requests[0].authorization).toBe("Bearer test_api_key");
  });

  test("Native Worker command applies a prebuilt create/update intent without another Publish prompt", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "userland-native-cli-")); tempDirs.push(directory);
    const configuration = '// preserve native comments\n{"name":"native-example","main":"worker.js","compatibility_date":"2026-10-17",}\n';
    await fs.writeFile(path.join(directory, "wrangler.jsonc"), configuration);
    await fs.writeFile(path.join(directory, "worker.js"), "export default { fetch() { return new Response('native') } };\n");
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "POST /v1/apps/apply": [{ operation_id: "nop_create", status: "running" }, { operation_id: "nop_update", status: "waiting" }] });
    const common = ["apps", "apply", directory, "--account", "acct_team", "--environment", "production", "--mode", "publish", "--json"];
    const create = await runCli([...common, "--name", "Native example", "--idempotency-key", "create-intent"], api.baseUrl);
    const update = await runCli([...common, "--app", "app_native", "--expected-revision", "1", "--idempotency-key", "update-intent"], api.baseUrl);
    expect(create.code, create.stderr).toBe(0); expect(update.code, update.stderr).toBe(0);
    expect(JSON.parse(create.stdout)).toMatchObject({ operation_id: "nop_create" });
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toMatchObject({ account_id: "acct_team", app: { create: { name: "Native example" } }, source: { files: { "wrangler.jsonc": configuration } }, target: { environment: "production", mode: "publish" }, idempotency_key: "create-intent" });
    expect(requests[1].body).toMatchObject({ account_id: "acct_team", app: { id: "app_native", expected_revision: 1 }, idempotency_key: "update-intent" });
    expect((requests[0].body as { source: { files: Record<string, string> } }).source.files).not.toHaveProperty("manifest.userland.json");
  });

  test("prints top-level help successfully", async () => {
    const result = await runCli(["--help"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("userland --version");
    for(const command of ["userland context","userland apps apply","userland apps get","userland apps run","userland operations get"])expect(result.stdout).toContain(command);
    for(const command of ["userland validate","userland apps publish","userland support","userland apps export"])expect(result.stdout).not.toContain(command);
    expect(result.stdout).not.toContain("userland " + "ops");
    expect(result.stderr).toBe("");
  });

  test("prints the CLI package version", async () => {
    const cliPackageVersion = await readCliPackageVersion();

    const result = await runCli(["--version"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${cliPackageVersion}\n`);
    expect(result.stderr).toBe("");
  });

  test("prints usage errors to stderr", async () => {
    const result = await runCli([], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  test("asks before revoking an API key in a terminal and treats closed input as no", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "DELETE /v0/auth/api-keys/key_1": { ok: true, revoked: true, api_key_id: "key_1" }
    });

    const confirmed = await runCli(["auth", "api-keys", "revoke", "key_1"], api.baseUrl, { tty: true, stdin: "yes\n" });
    expect(confirmed.code).toBe(0);
    expect(confirmed.stdout).toContain("Revoke API key key_1? Type yes to continue: ");
    expect(confirmed.stdout).toContain("Revoked API key key_1");

    const closed = await runCli(["auth", "api-keys", "revoke", "key_1"], api.baseUrl, { tty: true, stdin: "" });
    expect(closed.code).toBe(0);
    expect(closed.stdout).toContain("revocation=cancelled");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["DELETE /v0/auth/api-keys/key_1"]);
  });

  test("lists and selects accounts", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": {
        accounts: [
          { id: "acct_owner", account_id: "acct_owner", role: "owner", name: "Alice", owner_user_id: "usr_alice" },
          { id: "acct_team", account_id: "acct_team", role: "admin", name: "Client Workspace", owner_user_id: "usr_client" }
        ],
        default_account_id: "acct_owner"
      }
    });
    const credentialsFile = await temporaryCredentialsFile();

    const list = await runCli(["accounts", "list"], api.baseUrl);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("acct_owner\towner\tAlice");
    expect(list.stdout).toContain("default_account_id=acct_owner");
    expect(requests.at(-1)).toMatchObject({ method: "GET", url: "/v0/accounts" });
    expect(requests.at(-1)?.accountId).toBeUndefined();

    const use = await runCli(["accounts", "use", "acct_team"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(use.code).toBe(0);
    expect(use.stdout).toContain("selected_account_id=acct_team");
    const saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved.account_id).toBe("acct_team");
  });

  test("manages API keys without saving created secrets", async () => {
    const keySummary = {
      id: "key_initial",
      api_key_id: "key_initial",
      key_prefix: "ap_live_init",
      name: "Initial",
      created_at: "2026-05-23T00:00:00.000Z",
      last_used_at: null,
      revoked_at: null
    };
    const createdSummary = {
      id: "key_created",
      api_key_id: "key_created",
      key_prefix: "ap_live_crea",
      name: "CI deploy key",
      created_at: "2026-05-23T00:01:00.000Z",
      last_used_at: null,
      revoked_at: null
    };
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/auth/api-keys": { api_keys: [keySummary] },
      "POST /v0/auth/api-keys": {
        api_key: "ap_live_created_secret",
        api_key_id: "key_created",
        key_prefix: "ap_live_crea",
        key: createdSummary,
        warning: "Store this API key now. It will not be shown again."
      },
      "PATCH /v0/auth/api-keys/key_created": {
        ok: true,
        api_key_id: "key_created",
        key: { ...createdSummary, name: "Production deploy" }
      },
      "DELETE /v0/auth/api-keys/key_created": {
        ok: true,
        revoked: true,
        api_key_id: "key_created",
        key: { ...createdSummary, revoked_at: "2026-05-23T00:02:00.000Z" }
      },
      "DELETE /v0/auth/api-keys/key_revoked": {
        ok: true,
        revoked: false,
        api_key_id: "key_revoked",
        key: { ...createdSummary, id: "key_revoked", api_key_id: "key_revoked", revoked_at: "2026-05-23T00:02:00.000Z" }
      }
    });
    const credentialsFile = await temporaryCredentialsFile();

    const list = await runCli(["auth", "api-keys", "list"], api.baseUrl, { credentialsFile });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("key_initial\tactive\t2026-05-23T00:00:00.000Z\tnever\tap_live_init\tInitial");
    expect(list.stdout).not.toContain("secret");
    expect(requests.at(-1)).toMatchObject({ method: "GET", url: "/v0/auth/api-keys", authorization: "Bearer test_api_key" });

    const aliasList = await runCli(["api-keys", "list"], api.baseUrl, { credentialsFile });
    expect(aliasList.code).toBe(0);
    expect(aliasList.stdout).toContain("key_initial");

    const create = await runCli(["auth", "api-keys", "create", "--name", "CI deploy key"], api.baseUrl, { credentialsFile });
    expect(create.code).toBe(0);
    expect(create.stdout).toContain("Created API key key_created");
    expect(create.stdout).toContain("API key:\nap_live_created_secret");
    expect(create.stdout.match(/ap_live_created_secret/gu)).toHaveLength(1);
    expect(requests.find((request) => request.url === "/v0/auth/api-keys" && request.method === "POST")?.body).toEqual({ name: "CI deploy key" });
    await expect(fs.stat(credentialsFile)).rejects.toMatchObject({ code: "ENOENT" });

    const rename = await runCli(["auth", "api-keys", "rename", "key_created", "--name", "Production deploy"], api.baseUrl, { credentialsFile });
    expect(rename.code).toBe(0);
    expect(rename.stdout).toContain("Renamed API key key_created");
    expect(rename.stdout).toContain("Name: Production deploy");
    expect(requests.find((request) => request.url === "/v0/auth/api-keys/key_created" && request.method === "PATCH")?.body).toEqual({ name: "Production deploy" });

    const revoke = await runCli(["auth", "api-keys", "revoke", "key_created", "--yes"], api.baseUrl, { credentialsFile });
    expect(revoke.code).toBe(0);
    expect(revoke.stdout).toContain("Revoked API key key_created");

    const alreadyRevoked = await runCli(["auth", "api-keys", "revoke", "key_revoked", "--yes"], api.baseUrl, { credentialsFile });
    expect(alreadyRevoked.code).toBe(0);
    expect(alreadyRevoked.stdout).toContain("API key key_revoked was already revoked.");
  });

  test("logs in with device flow, stores credentials, and uses the saved API key", async () => {
    const requests: RequestRecord[] = [];
    const cliPackageVersion = await readCliPackageVersion();
    const api = await startMockApi(requests, {
      "POST /v0/auth/device/start": deviceStartResponse(),
      "POST /v0/auth/device/poll": [
        { ok: false, status: "authorization_pending" },
        {
          ok: true,
          status: "approved",
          api_key: "created_api_key",
          api_key_id: "apk_cli",
          username: "alice",
          accounts: [],
          default_account_id: "acct_created"
        }
      ],
      "GET /v1/context": {
        apps: [
          {
            app_id: "app_saved",
            name: "Saved",
            origin: "https://app_saved.apps.userland.fun/",
            live_release_id: null,
            updated_at: "2026-05-05T00:00:00.000Z"
          }
        ]
      }
    });
    const credentialsFile = await temporaryCredentialsFile();

    const login = await runCli(["login", "--no-browser", "--console-url", "https://console.local"], api.baseUrl, {
      apiKey: null,
      credentialsFile
    });

    expect(login.code).toBe(0);
    expect(login.stdout).toContain("https://console.local/device?code=ABCD-EFGH");
    expect(login.stdout).toContain("user_code=ABCD-EFGH");
    expect(login.stdout).toContain(`Saved API key to ${credentialsFile}`);
    expect(login.stdout).toContain("selected_account_id=acct_created");
    expect(login.stdout).not.toContain("created_api_key");
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v0/auth/device/start",
      authorization: undefined,
      body: { client: "userland-cli", client_version: cliPackageVersion, requested_capability: "api_key" }
    });
    expect(requests.filter((request) => request.url === "/v0/auth/device/poll")).toHaveLength(2);

    const saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      api_key: "created_api_key",
      api_key_id: "apk_cli",
      api_base_url: api.baseUrl,
      console_url: "https://console.local",
      username: "alice",
      account_id: "acct_created"
    });
    expect(saved).not.toHaveProperty("password");
    expect((await fs.stat(credentialsFile)).mode & 0o777).toBe(0o600);

    const list = await runCli(["context"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("app_saved");
    expect(requests.find((request) => request.url === "/v1/context")?.authorization).toBe("Bearer created_api_key");

    const status = await runCli(["auth", "status"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("api_key=file");
    expect(status.stdout).toContain("api_key_id=apk_cli");
    expect(status.stdout).toContain("console_url=https://console.local");
    expect(status.stdout).toContain("account=file");
    expect(status.stdout).toContain("account_id=acct_created");
    expect(status.stdout).toContain("username=alice");
    expect(status.stdout).not.toContain("account_login=");
  });

  test("honors slow_down polling responses", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/auth/device/start": deviceStartResponse(),
      "POST /v0/auth/device/poll": [
        { ok: false, status: "slow_down", interval: 0 },
        { ok: true, status: "approved", api_key: "slowed_key", api_key_id: "apk_slow", username: "alice", accounts: [], default_account_id: "acct_slow" }
      ]
    });
    const credentialsFile = await temporaryCredentialsFile();

    const login = await runCli(["login", "--no-browser"], api.baseUrl, {
      apiKey: null,
      credentialsFile
    });

    expect(login.code).toBe(0);
    expect(requests.filter((request) => request.url === "/v0/auth/device/poll")).toHaveLength(2);
    const saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved.api_key).toBe("slowed_key");
    expect(saved.account_id).toBe("acct_slow");
  });

  test("exits without saving credentials when device authorization is denied or expired", async () => {
    for (const status of ["denied", "expired"] as const) {
      const requests: RequestRecord[] = [];
      const api = await startMockApi(requests, {
        "POST /v0/auth/device/start": deviceStartResponse(),
        "POST /v0/auth/device/poll": { ok: false, status }
      });
      const credentialsFile = await temporaryCredentialsFile();

      const result = await runCli(["login", "--no-browser"], api.baseUrl, { apiKey: null, credentialsFile });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(status === "denied" ? "Device authorization was denied" : "Device authorization expired");
      await expect(fs.stat(credentialsFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(requests.filter((request) => request.url === "/v0/auth/device/poll")).toHaveLength(1);
    }
  });

  test("signup is an alias for device login", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/auth/device/start": deviceStartResponse(),
      "POST /v0/auth/device/poll": {
        ok: true,
        status: "approved",
        api_key: "signup_api_key",
        api_key_id: "apk_signup",
        username: "newuser",
        accounts: [],
        default_account_id: "acct_signup"
      }
    });
    const credentialsFile = await temporaryCredentialsFile();

    const signup = await runCli(["signup", "--no-browser", "--email", "newuser@example.com"], api.baseUrl, { apiKey: null, credentialsFile });

    expect(signup.code).toBe(0);
    expect(signup.stdout).toContain("Signup uses the same browser approval flow as login.");
    expect(signup.stdout).toContain("email_hint=newuser@example.com");
    expect(requests.map((request) => request.url)).not.toContain("/v0/accounts");
    const saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved.api_key).toBe("signup_api_key");
    expect(saved.account_id).toBe("acct_signup");
  });

  test("can save an existing API key and log out", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "DELETE /v0/auth/api-keys/apk_manual": { ok: true, revoked: true, api_key_id: "apk_manual" },
      "GET /v1/context": {
        apps: []
      }
    });
    const credentialsFile = await temporaryCredentialsFile();

    const saveKey = await runCli(["auth", "save-key", "--api-key", "manual_api_key", "--account", "acct_manual"], api.baseUrl, {
      apiKey: null,
      credentialsFile
    });

    expect(saveKey.code).toBe(0);
    let saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      api_key: "manual_api_key",
      account_id: "acct_manual"
    });
    expect(saved).not.toHaveProperty("username");
    expect(saved).not.toHaveProperty("password");

    await runCli(["context"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(requests.find((request) => request.url === "/v1/context")?.authorization).toBe("Bearer manual_api_key");

    saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    saved.api_key_id = "apk_manual";
    await fs.writeFile(credentialsFile, JSON.stringify(saved));

    const logout = await runCli(["auth", "logout", "--revoke"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(logout.code).toBe(0);
    expect(logout.stdout).toContain("revoked_api_key_id=apk_manual");
    expect(logout.stdout).toContain("local_credentials=removed");
    await expect(fs.stat(credentialsFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(requests.find((request) => request.url === "/v0/auth/api-keys/apk_manual")).toMatchObject({
      method: "DELETE",
      authorization: "Bearer manual_api_key"
    });
  });

  test("prints useful 403 API errors", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v1/context": {
        __status: 403,
        error: { code: "forbidden", message: "Your account role cannot perform this operation." }
      }
    });

    const result = await runCli(["context"], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("API 403: Your account role cannot perform this operation.");
    expect(result.stderr).toContain("error=forbidden");
  });

  test("sends USERLAND_API_KEY and a saved key only to their own API", async () => {
    const requests: RequestRecord[] = [];
    const savedApi = await startMockApi(requests, { "GET /v1/context": { apps: [] } });
    const otherApi = await startMockApi(requests, { "GET /v1/context": { apps: [] } });
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_key_id: "apk_saved", api_base_url: savedApi.baseUrl }));

    // A saved key is not sent to a different USERLAND_API_BASE_URL.
    const mismatch = await runCli(["context"], otherApi.baseUrl, { apiKey: null, credentialsFile });
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain(`The saved API key is for ${savedApi.baseUrl}, but USERLAND_API_BASE_URL is ${otherApi.baseUrl}.`);
    expect(requests).toHaveLength(0);

    // Without USERLAND_API_BASE_URL, the saved key goes to its own API, with a note that it is not the default.
    const saved = await runCli(["context"], savedApi.baseUrl, { apiKey: null, credentialsFile, env: { USERLAND_API_BASE_URL: undefined } });
    expect(saved.code).toBe(0);
    expect(saved.stderr).toContain(`note=api_base_url Using the API at ${savedApi.baseUrl}, saved with this API key in ${credentialsFile}.`);
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer saved_key"]);

    // USERLAND_API_KEY never goes to the saved URL: without USERLAND_API_BASE_URL it is for the default API.
    const status = await runCli(["auth", "status"], savedApi.baseUrl, { apiKey: "env_key", credentialsFile, env: { USERLAND_API_BASE_URL: undefined } });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("api_base_url=https://api.userland.fun\n");
    expect(status.stdout).toContain("api_key=env");

    // save-key and login do not reuse a URL saved by an earlier login.
    const saveKey = await runCli(["auth", "save-key"], savedApi.baseUrl, { apiKey: null, credentialsFile, stdin: "new_key", env: { USERLAND_API_BASE_URL: undefined } });
    expect(saveKey.code).toBe(0);
    expect(JSON.parse(await fs.readFile(credentialsFile, "utf8"))).toMatchObject({ api_key: "new_key", api_base_url: "https://api.userland.fun", console_url: "https://console.userland.fun" });
    expect(requests).toHaveLength(1);
  });

  test("refuses plain http API URLs other than localhost", async () => {
    const insecure = await runCli(["context"], "http://api.userland.test", {});
    expect(insecure.code).toBe(1);
    expect(insecure.stderr).toContain("API base URL must start with https:// (http:// is allowed only for localhost): http://api.userland.test");

    const credentialsFile = await temporaryCredentialsFile();
    const saveKey = await runCli(["auth", "save-key", "--api-base-url", "http://api.userland.test"], "http://127.0.0.1:1", { apiKey: null, credentialsFile, stdin: "key" });
    expect(saveKey.code).toBe(1);
    await expect(fs.stat(credentialsFile)).rejects.toMatchObject({ code: "ENOENT" });

    const withPassword = await runCli(["context"], "https://user:pass@api.userland.test", {});
    expect(withPassword.code).toBe(1);
    expect(withPassword.stderr).toContain("API base URL must not include a user name or password");
    expect(withPassword.stderr).not.toContain("pass@");
  });

  test("does not print or open a sign-in link that is not a safe console URL", async () => {
    const cases: Array<{ uri: string; env?: Record<string, string>; message: string }> = [
      { uri: "file:///etc/passwd", message: "The sign-in link from the API must start with https://" },
      { uri: "http://console.userland.test/device?code=A", message: "must start with https:// (http:// is allowed only for localhost)" },
      { uri: "https://evil.userland.test/device?code=A&calc.exe", env: { USERLAND_CONSOLE_URL: "https://console.local" }, message: "The sign-in link from the API is on https://evil.userland.test, not the Userland console at https://console.local" }
    ];
    for (const testCase of cases) {
      const requests: RequestRecord[] = [];
      const api = await startMockApi(requests, {
        "POST /v0/auth/device/start": { ...deviceStartResponse(), verification_uri_complete: testCase.uri },
        "POST /v0/auth/device/poll": { ok: true, status: "approved", api_key: "should_not_save" }
      });
      const credentialsFile = await temporaryCredentialsFile();

      const result = await runCli(["login", "--no-browser"], api.baseUrl, { apiKey: null, credentialsFile, env: testCase.env });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(testCase.message);
      expect(result.stdout).not.toContain(testCase.uri);
      expect(requests.map((request) => request.url)).toEqual(["/v0/auth/device/start"]);
      await expect(fs.stat(credentialsFile)).rejects.toMatchObject({ code: "ENOENT" });
    }

    // A link on the configured console is fine.
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/auth/device/start": deviceStartResponse(),
      "POST /v0/auth/device/poll": { ok: true, status: "approved", api_key: "console_key", api_key_id: "apk_console" }
    });
    const ok = await runCli(["login", "--no-browser"], api.baseUrl, { apiKey: null, env: { USERLAND_CONSOLE_URL: "https://console.local/" } });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("https://console.local/device?code=ABCD-EFGH");
  });

  test("a new login revokes the key saved by the previous login for the same API", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/auth/device/start": [deviceStartResponse(), deviceStartResponse(), deviceStartResponse()],
      "POST /v0/auth/device/poll": [
        { ok: true, status: "approved", api_key: "new_key", api_key_id: "apk_new", default_account_id: "acct_1" },
        { ok: true, status: "approved", api_key: "newer_key", api_key_id: "apk_newer", default_account_id: "acct_1" },
        { ok: true, status: "approved", api_key: "newest_key", api_key_id: "apk_newest", default_account_id: "acct_1" }
      ],
      "DELETE /v0/auth/api-keys/apk_old": { ok: true, revoked: true, api_key_id: "apk_old" },
      "DELETE /v0/auth/api-keys/apk_new": { __status: 404, error: { code: "not_found", message: "API key not found." } }
    });
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "old_key", api_key_id: "apk_old", api_base_url: api.baseUrl }));

    const first = await runCli(["login", "--no-browser"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("revoked_previous_api_key_id=apk_old");
    expect(requests.find((request) => request.method === "DELETE")).toMatchObject({ url: "/v0/auth/api-keys/apk_old", authorization: "Bearer new_key" });
    expect(JSON.parse(await fs.readFile(credentialsFile, "utf8"))).toMatchObject({ api_key: "new_key", api_key_id: "apk_new" });

    // If the old key cannot be revoked, the login still succeeds and says so.
    const second = await runCli(["login", "--no-browser"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("warning=previous_api_key_not_revoked The API key from your previous login (apk_new) is still active: API 404: API key not found.");
    expect(JSON.parse(await fs.readFile(credentialsFile, "utf8"))).toMatchObject({ api_key: "newer_key", api_key_id: "apk_newer" });

    // A key saved with auth save-key has no saved id and is left alone.
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "manual_key", api_base_url: api.baseUrl }));
    const deletesBefore = requests.filter((request) => request.method === "DELETE").length;
    const third = await runCli(["login", "--no-browser"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(third.code).toBe(0);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(deletesBefore);
  });

  test("a login revokes the key it actually replaces when another login saved one while it waited", async () => {
    const requests: RequestRecord[] = [];
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    const api = await startMockApi(requests, {
      // While this login waits for approval, another login (for example a parallel agent) saves its key.
      "POST /v0/auth/device/start": async () => {
        await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "other_login_key", api_key_id: "apk_other", api_base_url: api.baseUrl }));
        return deviceStartResponse();
      },
      "POST /v0/auth/device/poll": { ok: true, status: "approved", api_key: "new_key", api_key_id: "apk_new", default_account_id: "acct_1" },
      "DELETE /v0/auth/api-keys/apk_other": { ok: true, revoked: true, api_key_id: "apk_other" },
      "DELETE /v0/auth/api-keys/apk_old": { ok: true, revoked: true, api_key_id: "apk_old" }
    });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "old_key", api_key_id: "apk_old", api_base_url: api.baseUrl }));

    const result = await runCli(["login", "--no-browser"], api.baseUrl, { apiKey: null, credentialsFile });

    expect(result.code).toBe(0);
    // The key this login overwrote is apk_other; apk_old was already replaced by the other login.
    expect(result.stdout).toContain("revoked_previous_api_key_id=apk_other");
    expect(requests.filter((request) => request.method === "DELETE").map((request) => request.url)).toEqual(["/v0/auth/api-keys/apk_other"]);
    expect(JSON.parse(await fs.readFile(credentialsFile, "utf8"))).toMatchObject({ api_key: "new_key", api_key_id: "apk_new" });
  });

  test("logout says when the saved API key stays active", async () => {
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_key_id: "apk_saved", api_base_url: "http://127.0.0.1:1" }));

    const result = await runCli(["auth", "logout"], "http://127.0.0.1:1", { apiKey: null, credentialsFile });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("note=api_key_still_active The saved API key apk_saved was not revoked and still works.");
    await expect(fs.stat(credentialsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps credential folders and malformed files private", async () => {
    // A folder the CLI did not create keeps its permissions; the file itself is always 0600.
    const shared = await fs.mkdtemp(path.join(os.tmpdir(), "userland-shared-"));
    tempDirs.push(shared);
    await fs.chmod(shared, 0o755);
    const credentialsFile = path.join(shared, "creds.json");
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "old_key" }), { mode: 0o644 });
    await fs.chmod(credentialsFile, 0o644);

    const saved = await runCli(["auth", "save-key"], "http://127.0.0.1:1", { apiKey: null, credentialsFile, stdin: "shared_key" });
    expect(saved.code).toBe(0);
    expect((await fs.stat(shared)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(credentialsFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(credentialsFile, "utf8"))).toMatchObject({ api_key: "shared_key" });
    expect((await fs.readdir(shared)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    // A folder the CLI creates is private.
    const created = await temporaryCredentialsFile();
    const fresh = await runCli(["auth", "save-key"], "http://127.0.0.1:1", { apiKey: null, credentialsFile: created, stdin: "fresh_key" });
    expect(fresh.code).toBe(0);
    expect((await fs.stat(path.dirname(created))).mode & 0o777).toBe(0o700);

    // A malformed file is reported without quoting its contents.
    await fs.writeFile(credentialsFile, "ul_live_SUPERSECRET");
    const malformed = await runCli(["context"], "http://127.0.0.1:1", { apiKey: null, credentialsFile });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain(`Credentials file ${credentialsFile} is not valid JSON.`);
    expect(malformed.stderr).not.toContain("ul_live_SU");
  });
});

function accountsResponse(): Record<string, unknown> {
  return {
    accounts: [{ id: "acct_owner", account_id: "acct_owner", role: "owner", name: "Alice", owner_user_id: "usr_alice" }],
    default_account_id: "acct_owner"
  };
}

function limitsResponse(accountId: string, planKey: string): { features: Record<string, boolean>; manifest_limits: Record<string, unknown>; [key: string]: unknown } {
  const plan = plansArtifact.plans[planKey];
  return {
    account_id: accountId,
    plan_key: planKey,
    features: { ...plan.features },
    manifest_limits: { ...plan.manifest_limits },
    deployment_limits: {},
    runtime_limits: {},
    release_limits: { ...plan.release_limits },
    usage_limits: {},
    usage: {}
  };
}

function publishResponse(appId: string): Record<string, unknown> {
  return {
    status: "stored",
    app_id: appId,
    release_id: "rel_new",
    origin: `https://${appId}.apps.userland.fun/`,
    previous_release_id: null,
    activation: { status: "pending_secrets", reasons: [], missing_secrets: [], previous_release_id: null }
  };
}

/** GET /v0/apps/:app_id, as the API returns it. */
function appResponse(appId: string, name: string): Record<string, unknown> {
  return {
    app_id: appId,
    account_id: "acct_owner",
    name,
    summary: null,
    visibility: "public",
    production: false,
    origin: `https://${appId}.apps.userland.fun/`,
    live_release_id: "rel_live",
    operational_state: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z"
  };
}

/** DELETE /v0/apps/:app_id, as the API returns it. */
function unpublishResponse(appId: string): Record<string, unknown> {
  return { app_id: appId, status: "unpublished", deleted_at: "2026-09-28T00:00:00.000Z" };
}

/** GET /v0/apps/:app_id/secrets, as the API returns it (names and dates, never values). */
function secretsResponse(appId: string, names: string[]): { app_id: string; secrets: Array<Record<string, unknown>> } {
  return {
    app_id: appId,
    secrets: names.map((name) => ({ name, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z", present: true }))
  };
}

/** POST /v0/apps/:app_id/admin-invites, as the API returns it. */
function inviteResponse(roles: string[]): Record<string, unknown> {
  return {
    invite_id: "inv_1",
    email: "jo@example.com",
    roles,
    expires_at: "2026-10-08T00:00:00.000Z",
    invite_url: "https://app_portal.apps.userland.fun/_userland/auth/invite/inv_1?token=inv_abc"
  };
}

function analyticsResponse() {
  const dimension = (key: string, label: string, requestCount: number) => ({ key, label, dimensions: {}, request_count: requestCount, error_count: 0, total_response_bytes: 0 });
  return {
    app_id: "app_ops",
    account_id: "acct_ops",
    range: { from: "2026-05-05T00:00:00.000Z", to: "2026-06-04T00:00:00.000Z", days: 30 },
    entitlement: { enabled: true, plan_key: "business", retention_days: 30 },
    traffic: {
      total_requests: 1234,
      successful_requests: 1200,
      error_requests: 34,
      error_rate: 34 / 1234,
      total_response_bytes: 98765,
      status_buckets: { "2xx": 1200, "3xx": 0, "4xx": 20, "5xx": 14 }
    },
    series: [{ day: "2026-06-03", requests: 1234, errors: 34 }],
    status_buckets: [dimension("status:2xx", "2xx", 1200)],
    top_paths: [dimension("path:/", "/", 500), dimension("path:/pricing", "/pricing", 210), dimension("path:/book", "/book", 180)],
    top_referrers: [dimension("__direct__", "__direct__", 700), dimension("referrer:google.com", "google.com", 250)],
    routes: [],
    runtime_targets: [],
    auth: { enabled: false, signups: 0, sessions_created: 0 },
    jobs: { queued: 0, running: 0, succeeded: 12, failed: 1, dead: 0 },
    webhooks: { received: 0, verified: 0, rejected: 0, queued: 0, delivered: 0, failed: 0 },
    recent_errors: [
      {
        app_event_id: "evt_1",
        release_id: "rel_live",
        type: "runtime.exception",
        event_type: "runtime.exception",
        severity: "error",
        level: "error",
        message: "TypeError: boom",
        request_id: "req_1",
        created_at: "2026-06-03T10:00:00.000Z"
      }
    ]
  };
}

async function temporaryAppDir(manifest: unknown, files: Record<string, string> = { "public/index.html": "<h1>hi</h1>" }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "userland-app-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "manifest.userland.json"), JSON.stringify(manifest));
  for (const [filePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, filePath)), { recursive: true });
    await fs.writeFile(path.join(dir, filePath), contents);
  }
  return dir;
}

async function expectCommand(args: string[], baseUrl: string, stdoutNeedle: string): Promise<void> {
  const result = await runCli(args, baseUrl);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(stdoutNeedle);
}

async function runCli(
  args: string[],
  apiBaseUrl: string,
  options: { accountId?: string; apiKey?: string | null; credentialsFile?: string; stdin?: string; tty?: boolean; env?: Record<string, string | undefined>; interruptWhen?: RegExp } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const credentialsFile = options.credentialsFile ?? (await temporaryCredentialsFile());
  return await new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERLAND_API_BASE_URL: apiBaseUrl,
      USERLAND_CREDENTIALS_FILE: credentialsFile
    };
    if (options.apiKey !== null) {
      env.USERLAND_API_KEY = options.apiKey ?? "test_api_key";
    } else {
      delete env.USERLAND_API_KEY;
    }
    if (options.accountId) {
      env.USERLAND_ACCOUNT_ID = options.accountId;
    } else {
      delete env.USERLAND_ACCOUNT_ID;
    }
    delete env.USERLAND_CONSOLE_URL;
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }

    // With tty, piped stdin looks like a terminal, so a test can answer confirmation prompts.
    const ttyImport = options.tty ? ["--import", pathToFileURL(stdinIsTtyPreload).href] : [];
    const child = spawn(process.execPath, ["--import", "tsx", ...ttyImport, path.join("cli", "src", "index.ts"), ...args], {
      cwd: repoRoot,
      env,
      stdio: [options.stdin === undefined && !options.tty ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    let interrupted = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      // Ctrl-C, once the CLI has printed what the test waits for.
      if (options.interruptWhen && !interrupted && options.interruptWhen.test(Buffer.concat(stderr).toString("utf8"))) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    if (options.stdin !== undefined || options.tty) {
      child.stdin?.end(options.stdin ?? "");
    }
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function temporaryCredentialsFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "userland-cli-"));
  tempDirs.push(dir);
  return path.join(dir, ".userland", "credentials.json");
}

async function readCliPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(await fs.readFile(cliPackageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Missing CLI package version");
  }

  return packageJson.version;
}

function deviceStartResponse(): Record<string, unknown> {
  return {
    device_code: "dev_test_device_code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://console.local/device",
    verification_uri_complete: "https://console.local/device?code=ABCD-EFGH",
    expires_in: 60,
    interval: 0
  };
}

async function startMockApi(
  requests: RequestRecord[],
  routes: Record<string, unknown | unknown[]>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    await handleRequest(request, response, requests, routes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock API did not bind to a TCP port.");
  }
  const api = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
  servers.push(api);
  return api;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: RequestRecord[],
  routes: Record<string, unknown | unknown[]>
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const rawBody = bytes.toString("utf8");
  const key = `${request.method ?? "GET"} ${request.url ?? "/"}`;
  const isJson = String(request.headers["content-type"] ?? "application/json").includes("json");
  requests.push({
    method: request.method ?? "GET",
    url: request.url ?? "/",
    authorization: request.headers.authorization,
    accountId: Array.isArray(request.headers["x-userland-account-id"])
      ? request.headers["x-userland-account-id"][0]
      : request.headers["x-userland-account-id"],
    body: rawBody && isJson ? JSON.parse(rawBody) : undefined,
    rawBody: bytes,
    headers: request.headers
  });

  if (!(key in routes)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: key } }));
    return;
  }

  const configuredRoute = routes[key];
  const picked = Array.isArray(configuredRoute) ? configuredRoute.shift() : configuredRoute;
  // A function route runs when the request arrives (for example to change files mid-command).
  const route = typeof picked === "function" ? await (picked as () => unknown)() : picked;
  // Bytes rather than JSON, as the file reads answer.
  if (typeof route === "object" && route !== null && "__raw" in route) {
    const raw = route as { __raw: string | Uint8Array; __status?: number; __headers?: Record<string, string> };
    response.writeHead(raw.__status ?? 200, { "content-type": "application/octet-stream", ...raw.__headers });
    response.end(Buffer.from(raw.__raw));
    return;
  }
  if (typeof route === "object" && route !== null && "__status" in route) {
    const { __status, ...body } = route as { __status: number; [key: string]: unknown };
    response.writeHead(__status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(route));
}

describe("retired command boundary",()=>{
 test("does not send retired app/runtime/admin commands to the API",async()=>{
  const requests:RequestRecord[]=[];const api=await startMockApi(requests,{});
  for(const args of [["apps","publish","."],["apps","export","app_one"],["apps","invites","create","app_one"],["validate","."],["support","open"],["accounts","limits"]]){
   const result=await runCli(args,api.baseUrl);expect(result.code).toBe(1);
  }
  expect(requests).toEqual([]);
 });
 test("never reads a native secret value from stdin or a plaintext flag",async()=>{
  const requests:RequestRecord[]=[];const api=await startMockApi(requests,{});
  for(const args of [["apps","secrets","set","app_one","TOKEN","--value","private-plaintext"],["apps","secrets","set","app_one","TOKEN"]]){
   const result=await runCli(args,api.baseUrl,{stdin:"private-stdin-value"});expect(result.code).toBe(1);expect(result.stdout+result.stderr).not.toContain("private-plaintext");expect(result.stdout+result.stderr).not.toContain("private-stdin-value");
  }
  expect(requests).toEqual([]);
 });
});

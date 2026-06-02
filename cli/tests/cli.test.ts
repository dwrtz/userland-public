import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

interface RequestRecord {
  method: string;
  url: string;
  authorization: string | undefined;
  accountId: string | undefined;
  body: unknown;
}

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPackageJsonPath = path.join(repoRoot, "cli", "package.json");

describe("public CLI", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test("prints top-level help successfully", async () => {
    const result = await runCli(["--help"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("userland --version");
    expect(result.stdout).toContain("userland apps publish");
    expect(result.stdout).toContain("userland support open");
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

  test("publishes hello-static to the configured API", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "PUT /v0/apps": {
        status: "created",
        app_id: "app_hello",
        release_id: "rel_hello",
        origin: "https://app_hello.apps.userland.fun/",
        previous_release_id: null,
        activation: {
          status: "active",
          reasons: [],
          previous_release_id: null
        }
      }
    });

    const result = await runCli(["apps", "publish", "examples/hello-static", "--message", "test release"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Published https://app_hello.apps.userland.fun/");
    expect(result.stdout).toContain("app_id=app_hello");
    expect(result.stdout).toContain("release_id=rel_hello");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].url).toBe("/v0/apps");
    expect(requests[0].authorization).toBe("Bearer test_api_key");
    expect(requests[0].accountId).toBeUndefined();

    const body = requests[0].body as { files?: Array<{ path: string; content_base64: string }>; message?: string };
    expect(body.message).toBe("test release");
    expect(body.files?.map((file) => file.path).sort()).toEqual([
      "AGENT.md",
      "README.md",
      "example.json",
      "public/assets/app.css",
      "public/index.html"
    ]);
    expect(body.files?.map((file) => file.path)).not.toContain("manifest.userland.json");
    const index = body.files?.find((file) => file.path === "public/index.html");
    expect(Buffer.from(index?.content_base64 ?? "", "base64").toString("utf8")).toContain("Hello from Userland");
  });

  test("supports list, releases, events, rollback, and secrets commands", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps": {
        apps: [
          {
            app_id: "app_ops",
            name: "Ops",
            origin: "https://app_ops.apps.userland.fun/",
            live_release_id: "rel_live",
            updated_at: "2026-05-05T00:00:00.000Z"
          }
        ]
      },
      "GET /v0/apps/app_ops/releases": {
        releases: [
          {
            release_id: "rel_live",
            created_at: "2026-05-05T00:00:00.000Z",
            is_live: true,
            activation_status: "active",
            message: "live"
          }
        ]
      },
      "GET /v0/apps/app_ops/events?severity=error&limit=2": {
        events: [
          {
            app_event_id: "evt_1",
            type: "runtime.error",
            severity: "error",
            message: "boom",
            release_id: "rel_live",
            created_at: "2026-05-05T00:00:00.000Z"
          }
        ],
        cursor: null
      },
      "POST /v0/apps/app_ops/rollback": {
        app_id: "app_ops",
        release_id: "rel_prev",
        previous_release_id: "rel_live",
        origin: "https://app_ops.apps.userland.fun/",
        status: "active"
      },
      "PUT /v0/apps/app_ops/secrets/API_TOKEN": {
        name: "API_TOKEN",
        present: true,
        updated_at: "2026-05-05T00:00:00.000Z"
      }
    });

    await expectCommand(["apps", "list"], api.baseUrl, "app_ops");
    await expectCommand(["apps", "releases", "app_ops"], api.baseUrl, "rel_live live");
    await expectCommand(["versions", "app_ops"], api.baseUrl, "rel_live live");
    await expectCommand(["apps", "events", "app_ops", "--severity", "error", "--limit", "2"], api.baseUrl, "runtime.error");
    await expectCommand(["apps", "rollback", "app_ops", "rel_prev"], api.baseUrl, "Rolled back https://app_ops.apps.userland.fun/");
    const secretResult = await runCli(["apps", "secrets", "set", "app_ops", "API_TOKEN", "--value", "super-secret"], api.baseUrl);

    expect(secretResult.code).toBe(0);
    expect(secretResult.stdout).toContain("secret=API_TOKEN");
    expect(secretResult.stdout).not.toContain("super-secret");
    expect(requests.find((request) => request.url === "/v0/apps/app_ops/secrets/API_TOKEN")?.body).toEqual({ value: "super-secret" });
  });

  test("supports account selection from env, saved credentials, and --account", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps": { apps: [] },
      "GET /v0/apps/app_ops/releases": { releases: [] }
    });
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_base_url: api.baseUrl, account_id: "acct_file" }));

    const fromEnv = await runCli(["apps", "list"], api.baseUrl, { accountId: "acct_env" });
    expect(fromEnv.code).toBe(0);
    expect(requests.at(-1)?.accountId).toBe("acct_env");

    const fromFlag = await runCli(["apps", "list", "--account", "acct_flag"], api.baseUrl, { accountId: "acct_env" });
    expect(fromFlag.code).toBe(0);
    expect(requests.at(-1)?.accountId).toBe("acct_flag");

    const fromFile = await runCli(["apps", "releases", "app_ops"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(fromFile.code).toBe(0);
    expect(requests.at(-1)?.authorization).toBe("Bearer saved_key");
    expect(requests.at(-1)?.accountId).toBe("acct_file");
  });

  test("opens support requests with explicit messages or stdin", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/support/requests": [
        {
          status: "sent",
          correlation_id: "sup_message",
          reply_to_email: "alice@example.com"
        },
        {
          status: "sent",
          correlation_id: "sup_stdin",
          reply_to_email: "alice@example.com"
        }
      ]
    });

    const message = await runCli([
      "support",
      "open",
      "--subject",
      "Deploy failed",
      "--message",
      "The latest release is throwing errors.",
      "--app",
      "app_ops",
      "--account",
      "acct_support"
    ], api.baseUrl);

    expect(message.code).toBe(0);
    expect(message.stdout).toContain("Support request sent.");
    expect(message.stdout).toContain("correlation_id=sup_message");
    expect(message.stdout).toContain("reply_to_email=alice@example.com");
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/v0/support/requests",
      authorization: "Bearer test_api_key",
      accountId: "acct_support",
      body: {
        subject: "Deploy failed",
        message: "The latest release is throwing errors.",
        app_id: "app_ops"
      }
    });

    const stdin = await runCli(["support", "open", "--subject", "Logs look wrong", "--json"], api.baseUrl, {
      stdin: "Here are details from stdin.\n"
    });

    expect(stdin.code).toBe(0);
    expect(JSON.parse(stdin.stdout)).toEqual({
      status: "sent",
      correlation_id: "sup_stdin",
      reply_to_email: "alice@example.com"
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/v0/support/requests",
      accountId: undefined,
      body: {
        subject: "Logs look wrong",
        message: "Here are details from stdin."
      }
    });
  });

  test("requires support subject and message", async () => {
    const missingSubject = await runCli(["support", "open", "--message", "hello"], "http://127.0.0.1:1");
    expect(missingSubject.code).toBe(1);
    expect(missingSubject.stderr).toContain("--subject is required.");

    const missingMessage = await runCli(["support", "open", "--subject", "Need help"], "http://127.0.0.1:1");
    expect(missingMessage.code).toBe(1);
    expect(missingMessage.stderr).toContain("--message is required or provide message on stdin.");
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

  test("supports account status, limits, and downgrade preview commands", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts/acct_ops/status": {
        account_id: "acct_ops",
        plan_key: "business",
        billing_access_state: "past_due_grace",
        grace_ends_at: "2026-05-19T00:00:00.000Z",
        account_flags: ["billing_restricted"],
        restricted: true,
        suspended: false,
        reasons: ["billing:past_due_grace"],
        warnings: [{ code: "billing_restricted", message: "Billing restrictions are active." }]
      },
      "GET /v0/accounts/acct_ops/limits": {
        account_id: "acct_ops",
        plan_key: "business",
        features: { custom_domains: true },
        manifest_limits: { "jobs.declared.max": 10 },
        deployment_limits: { "custom_domains.max": 5 },
        runtime_limits: { "server.cpu_ms.max": 50 },
        release_limits: { "release.file_count.max": 500 },
        usage_limits: { "requests.monthly.max": 100000 },
        usage: { "requests.monthly.max": 42 },
        usage_period: { period_start: "2026-05-01T00:00:00.000Z", period_end: "2026-06-01T00:00:00.000Z" },
        route_counts: { active_custom_domains: 1 },
        compatibility_warnings: []
      },
      "GET /v0/accounts/acct_ops/downgrade-preview?plan=free": {
        account_id: "acct_ops",
        current_plan_key: "business",
        target_plan_key: "free",
        compatible: false,
        violations: [{ type: "deployment_limit", key: "custom_domains.max", current: 1, allowed: 0, message: "Custom domains exceed Free." }],
        actions: [{ action: "disable_route", route_id: "route_domain", reason: "Custom domains exceed Free." }]
      }
    });

    const status = await runCli(["accounts", "status", "--account", "acct_ops"], api.baseUrl);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("billing_access_state=past_due_grace");
    expect(status.stdout).toContain("account_flags=billing_restricted");
    expect(requests.at(-1)).toMatchObject({ method: "GET", url: "/v0/accounts/acct_ops/status", accountId: "acct_ops" });

    const limits = await runCli(["accounts", "limits", "--account", "acct_ops"], api.baseUrl);
    expect(limits.code).toBe(0);
    expect(limits.stdout).toContain("manifest_limit=jobs.declared.max value=10");
    expect(limits.stdout).toContain("deployment_limit=custom_domains.max value=5");
    expect(limits.stdout).toContain("usage=requests.monthly.max value=42");

    const preview = await runCli(["accounts", "downgrade", "preview", "--to", "free", "--account", "acct_ops"], api.baseUrl);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("compatible=false");
    expect(preview.stdout).toContain("violation=type=deployment_limit key=custom_domains.max");
  });

  test("supports app status and route management commands", async () => {
    const route = {
      route_id: "route_slug",
      account_id: "acct_ops",
      app_id: "app_ops",
      route_type: "slug",
      hostname: "demo.apps.userland.fun",
      slug: "demo",
      status: "active",
      reason: null,
      verification: {},
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      deleted_at: null
    };
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_ops": {
        app_id: "app_ops",
        account_id: "acct_ops",
        name: "Ops",
        origin: "https://app_ops.apps.userland.fun/",
        live_release_id: "rel_live",
        operational_state: {
          billing_access_state: "active",
          suspended: false,
          takedown: false,
          can_serve_canonical: true,
          can_mutate: true,
          account_flags: [],
          app_flags: [],
          reasons: []
        }
      },
      "GET /v0/apps/app_ops/routes": { app_id: "app_ops", routes: [route] },
      "GET /v0/apps/app_ops/slugs": { app_id: "app_ops", routes: [route] },
      "POST /v0/apps/app_ops/slugs": { app_id: "app_ops", route },
      "DELETE /v0/apps/app_ops/slugs/demo": { app_id: "app_ops", route: { ...route, status: "deleted" } },
      "GET /v0/apps/app_ops/domains": { app_id: "app_ops", routes: [{ ...route, route_type: "custom_domain", hostname: "www.example.com", slug: null }] },
      "POST /v0/apps/app_ops/domains": { app_id: "app_ops", route: { ...route, route_type: "custom_domain", hostname: "www.example.com", slug: null, status: "pending_dns" } },
      "POST /v0/apps/app_ops/domains/www.example.com/verify": { app_id: "app_ops", route: { ...route, route_type: "custom_domain", hostname: "www.example.com", slug: null } },
      "DELETE /v0/apps/app_ops/domains/www.example.com": { app_id: "app_ops", route: { ...route, route_type: "custom_domain", hostname: "www.example.com", slug: null, status: "deleted" } }
    });

    await expectCommand(["apps", "status", "app_ops", "--account", "acct_ops"], api.baseUrl, "can_serve_canonical=true");
    await expectCommand(["apps", "routes", "list", "app_ops", "--account", "acct_ops"], api.baseUrl, "route_slug\tslug\tactive");
    await expectCommand(["apps", "slugs", "list", "app_ops", "--account", "acct_ops"], api.baseUrl, "demo.apps.userland.fun");
    await expectCommand(["apps", "slugs", "add", "app_ops", "demo", "--account", "acct_ops"], api.baseUrl, "route_slug");
    expect(requests.at(-1)?.body).toEqual({ slug: "demo" });
    await expectCommand(["apps", "slugs", "remove", "app_ops", "demo", "--account", "acct_ops"], api.baseUrl, "deleted");
    await expectCommand(["apps", "domains", "list", "app_ops", "--account", "acct_ops"], api.baseUrl, "www.example.com");
    await expectCommand(["apps", "domains", "add", "app_ops", "www.example.com", "--account", "acct_ops"], api.baseUrl, "pending_dns");
    expect(requests.at(-1)?.body).toEqual({ hostname: "www.example.com" });
    await expectCommand(["apps", "domains", "verify", "app_ops", "www.example.com", "--account", "acct_ops"], api.baseUrl, "active");
    await expectCommand(["apps", "domains", "remove", "app_ops", "www.example.com", "--account", "acct_ops"], api.baseUrl, "deleted");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toContain("POST /v0/apps/app_ops/domains/www.example.com/verify");
    expect(requests.every((request) => request.accountId === "acct_ops")).toBe(true);
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
      "GET /v0/apps": {
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

    const login = await runCli(["login", "--no-browser", "--console-url", "http://console.local"], api.baseUrl, {
      apiKey: null,
      credentialsFile
    });

    expect(login.code).toBe(0);
    expect(login.stdout).toContain("http://console.local/device?code=ABCD-EFGH");
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
      console_url: "http://console.local",
      username: "alice",
      account_id: "acct_created"
    });
    expect(saved).not.toHaveProperty("password");
    expect((await fs.stat(credentialsFile)).mode & 0o777).toBe(0o600);

    const list = await runCli(["apps", "list"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("app_saved");
    expect(requests.find((request) => request.url === "/v0/apps")?.authorization).toBe("Bearer created_api_key");

    const status = await runCli(["auth", "status"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("api_key=file");
    expect(status.stdout).toContain("api_key_id=apk_cli");
    expect(status.stdout).toContain("console_url=http://console.local");
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
      "GET /v0/apps": {
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

    await runCli(["apps", "list"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(requests.find((request) => request.url === "/v0/apps")?.authorization).toBe("Bearer manual_api_key");

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
      "GET /v0/apps": {
        __status: 403,
        error: { code: "forbidden", message: "Your account role cannot perform this operation." }
      }
    });

    const result = await runCli(["apps", "list"], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("API 403: Your account role cannot perform this operation.");
    expect(result.stderr).toContain("error=forbidden");
  });

  test("prints entitlement details from 402 API errors", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "PUT /v0/apps": {
        __status: 402,
        error: {
          code: "entitlement_required",
          message: "This app manifest uses features or limits outside the account plan.",
          details: {
            plan_key: "free",
            required_plan_key: "business",
            violations: [
              {
                kind: "manifest_feature",
                feature_key: "private_apps",
                manifest_path: "/app/visibility",
                value: "private",
                required_plan_key: "business"
              },
              {
                kind: "manifest_limit",
                limit_key: "jobs.schedule.allowed",
                manifest_path: "/resources/jobs/*/schedule",
                value: 1,
                allowed: ["daily"],
                required_plan_key: "business"
              }
            ]
          }
        }
      }
    });

    const result = await runCli(["apps", "publish", "examples/hello-static"], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("API 402: This app manifest uses features or limits outside the account plan.");
    expect(result.stderr).toContain("error=entitlement_required");
    expect(result.stderr).toContain("required_plan_key=business");
    expect(result.stderr).toContain("violation=/app/visibility feature=private_apps value=private requires=business");
    expect(result.stderr).toContain("violation=/resources/jobs/*/schedule limit=jobs.schedule.allowed value=1 allowed=daily requires=business");
    expect(result.stderr).toContain("Docs: https://docs.userland.fun/reference/errors");
  });
});

async function expectCommand(args: string[], baseUrl: string, stdoutNeedle: string): Promise<void> {
  const result = await runCli(args, baseUrl);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(stdoutNeedle);
}

async function runCli(
  args: string[],
  apiBaseUrl: string,
  options: { accountId?: string; apiKey?: string | null; credentialsFile?: string; stdin?: string } = {}
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

    const child = spawn(process.execPath, ["--import", "tsx", path.join("cli", "src", "index.ts"), ...args], {
      cwd: repoRoot,
      env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
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
    verification_uri: "http://console.local/device",
    verification_uri_complete: "http://console.local/device?code=ABCD-EFGH",
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
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const key = `${request.method ?? "GET"} ${request.url ?? "/"}`;
  requests.push({
    method: request.method ?? "GET",
    url: request.url ?? "/",
    authorization: request.headers.authorization,
    accountId: Array.isArray(request.headers["x-userland-account-id"])
      ? request.headers["x-userland-account-id"][0]
      : request.headers["x-userland-account-id"],
    body: rawBody ? JSON.parse(rawBody) : undefined
  });

  if (!(key in routes)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: key } }));
    return;
  }

  const configuredRoute = routes[key];
  const route = Array.isArray(configuredRoute) ? configuredRoute.shift() : configuredRoute;
  if (typeof route === "object" && route !== null && "__status" in route) {
    const { __status, ...body } = route as { __status: number; [key: string]: unknown };
    response.writeHead(__status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(route));
}

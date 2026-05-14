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

describe("public CLI", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test("prints top-level help successfully", async () => {
    const result = await runCli(["--help"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("userland apps publish");
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
        manifest_limits: {},
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

  test("supports internal ops command routing", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/ops/accounts/acct_ops/status": { account_id: "acct_ops", billing_access_state: "active", account_flags: [] },
      "POST /v0/ops/accounts/acct_ops/flags/suspended_abuse": { account_id: "acct_ops", flag: "suspended_abuse", active: true },
      "POST /v0/ops/accounts/acct_ops/flags/suspended_abuse/clear": { account_id: "acct_ops", flag: "suspended_abuse", active: false },
      "GET /v0/ops/apps/app_ops/status": { app_id: "app_ops", suspended: false },
      "POST /v0/ops/apps/app_ops/flags/suspended_security": { app_id: "app_ops", flag: "suspended_security", active: true },
      "POST /v0/ops/apps/app_ops/flags/suspended_security/clear": { app_id: "app_ops", flag: "suspended_security", active: false },
      "POST /v0/ops/apps/app_ops/takedown": { app_id: "app_ops", flag: "takedown_legal", active: true },
      "POST /v0/ops/routes/route_ops/disable": { route_id: "route_ops", status: "disabled_abuse" },
      "POST /v0/ops/routes/route_ops/enable": { route_id: "route_ops", status: "active" }
    });

    await expectCommand(["ops", "accounts", "status", "acct_ops"], api.baseUrl, "account_id=acct_ops");
    await expectCommand(["ops", "accounts", "flag", "acct_ops", "suspended_abuse", "--reason", "spam"], api.baseUrl, "active=true");
    expect(requests.at(-1)?.body).toEqual({ reason: "spam" });
    await expectCommand(["ops", "accounts", "clear", "acct_ops", "suspended_abuse"], api.baseUrl, "active=false");
    await expectCommand(["ops", "apps", "status", "app_ops"], api.baseUrl, "suspended=false");
    await expectCommand(["ops", "apps", "flag", "app_ops", "suspended_security"], api.baseUrl, "active=true");
    await expectCommand(["ops", "apps", "clear", "app_ops", "suspended_security"], api.baseUrl, "active=false");
    await expectCommand(["ops", "apps", "takedown", "app_ops", "--reason", "legal"], api.baseUrl, "flag=takedown_legal");
    await expectCommand(["ops", "routes", "disable", "route_ops", "--status", "disabled_abuse", "--reason", "spam"], api.baseUrl, "status=disabled_abuse");
    expect(requests.at(-1)?.body).toEqual({ status: "disabled_abuse", reason: "spam" });
    await expectCommand(["ops", "routes", "enable", "route_ops"], api.baseUrl, "status=active");
  });

  test("signs up, stores credentials, and uses the saved API key", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/accounts": {
        username: "newuser",
        api_key: "created_api_key",
        account_id: "acct_created",
        warning: "Store this API key now. It will not be shown again."
      },
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
    const keychainFile = `${credentialsFile}.keychain.json`;

    const signup = await runCli(["signup", "--username", "NewUser", "--password", "secret-password", "--email", "newuser@example.com"], api.baseUrl, {
      apiKey: null,
      credentialsFile,
      keychainFile
    });

    expect(signup.code).toBe(0);
    expect(signup.stdout).toContain("Created Userland account newuser");
    expect(signup.stdout).toContain(`Saved API key to ${credentialsFile}`);
    expect(signup.stdout).toContain("Saved account login to test keychain");
    expect(signup.stdout).not.toContain("created_api_key");
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v0/accounts",
      authorization: undefined,
      body: { username: "NewUser", password: "secret-password", email: "newuser@example.com" }
    });

    const saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      api_key: "created_api_key",
      api_base_url: api.baseUrl,
      account_id: "acct_created"
    });
    expect(saved).not.toHaveProperty("username");
    expect(saved).not.toHaveProperty("password");
    expect((await fs.stat(credentialsFile)).mode & 0o777).toBe(0o600);
    expect(await readStoredAccount(keychainFile)).toMatchObject({
      username: "newuser",
      password: "secret-password"
    });

    const list = await runCli(["apps", "list"], api.baseUrl, { apiKey: null, credentialsFile, keychainFile });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("app_saved");
    expect(requests.find((request) => request.url === "/v0/apps")?.authorization).toBe("Bearer created_api_key");

    const status = await runCli(["auth", "status"], api.baseUrl, { apiKey: null, credentialsFile, keychainFile });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("api_key=file");
    expect(status.stdout).toContain("account=file");
    expect(status.stdout).toContain("account_id=acct_created");
    expect(status.stdout).toContain("account_login=keychain");
    expect(status.stdout).toContain("username=newuser");
  });

  test("logs in and can save an existing API key", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/auth/token": {
        api_key: "login_api_key",
        warning: "Store this API key now. It will not be shown again."
      },
      "GET /v0/apps": {
        apps: []
      }
    });
    const credentialsFile = await temporaryCredentialsFile();
    const keychainFile = `${credentialsFile}.keychain.json`;

    const login = await runCli(["auth", "login", "--username", "dwrtz", "--password", "secret-password"], api.baseUrl, {
      apiKey: null,
      credentialsFile,
      keychainFile
    });

    expect(login.code).toBe(0);
    expect(login.stdout).toContain(`Saved API key to ${credentialsFile}`);
    expect(login.stdout).toContain("Saved account login to test keychain");
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v0/auth/token",
      authorization: undefined,
      body: { username: "dwrtz", password: "secret-password" }
    });

    const saveKey = await runCli(["auth", "save-key", "--username", "dwrtz", "--api-key", "manual_api_key"], api.baseUrl, {
      apiKey: null,
      credentialsFile,
      keychainFile
    });

    expect(saveKey.code).toBe(0);
    const saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      api_key: "manual_api_key"
    });
    expect(saved).not.toHaveProperty("account_id");
    expect(saved).not.toHaveProperty("username");
    expect(saved).not.toHaveProperty("password");
    expect(await readStoredAccount(keychainFile)).toMatchObject({
      username: "dwrtz",
      password: "secret-password"
    });

    await runCli(["apps", "list"], api.baseUrl, { apiKey: null, credentialsFile, keychainFile });
    expect(requests.find((request) => request.url === "/v0/apps")?.authorization).toBe("Bearer manual_api_key");
  });

  test("does not require account support from older signup or login responses", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/accounts": {
        username: "legacy",
        api_key: "legacy_signup_key",
        warning: "Store this API key now. It will not be shown again."
      },
      "POST /v0/auth/token": {
        api_key: "legacy_login_key",
        warning: "Store this API key now. It will not be shown again."
      }
    });
    const credentialsFile = await temporaryCredentialsFile();
    const keychainFile = `${credentialsFile}.keychain.json`;
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "old_key", api_base_url: api.baseUrl, account_id: "acct_stale" }));

    const signup = await runCli(["signup", "--username", "legacy", "--password", "secret-password"], api.baseUrl, {
      apiKey: null,
      credentialsFile,
      keychainFile
    });
    expect(signup.code).toBe(0);
    let saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved.api_key).toBe("legacy_signup_key");
    expect(saved).not.toHaveProperty("account_id");

    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "old_key", api_base_url: api.baseUrl, account_id: "acct_stale" }));

    const login = await runCli(["login", "--username", "legacy", "--password", "secret-password"], api.baseUrl, {
      apiKey: null,
      credentialsFile,
      keychainFile
    });
    expect(login.code).toBe(0);
    saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved.api_key).toBe("legacy_login_key");
    expect(saved).not.toHaveProperty("account_id");
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
  options: { accountId?: string; apiKey?: string | null; credentialsFile?: string; keychainFile?: string } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERLAND_API_BASE_URL: apiBaseUrl
    };
    if (options.apiKey !== null) {
      env.USERLAND_API_KEY = options.apiKey ?? "test_api_key";
    } else {
      delete env.USERLAND_API_KEY;
    }
    if (options.credentialsFile) {
      env.USERLAND_CREDENTIALS_FILE = options.credentialsFile;
    }
    if (options.keychainFile) {
      env.USERLAND_KEYCHAIN_FILE = options.keychainFile;
    }
    if (options.accountId) {
      env.USERLAND_ACCOUNT_ID = options.accountId;
    } else {
      delete env.USERLAND_ACCOUNT_ID;
    }

    const child = spawn(process.execPath, ["--import", "tsx", path.join("cli", "src", "index.ts"), ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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

async function readStoredAccount(keychainFile: string): Promise<Record<string, unknown> | undefined> {
  const raw = JSON.parse(await fs.readFile(keychainFile, "utf8")) as Record<string, string>;
  const credentials = raw["fun.userland.cli:default"];
  return credentials ? (JSON.parse(credentials) as Record<string, unknown>) : undefined;
}

async function startMockApi(
  requests: RequestRecord[],
  routes: Record<string, unknown>
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
  routes: Record<string, unknown>
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

  const route = routes[key];
  if (typeof route === "object" && route !== null && "__status" in route) {
    const { __status, ...body } = route as { __status: number; [key: string]: unknown };
    response.writeHead(__status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(route));
}

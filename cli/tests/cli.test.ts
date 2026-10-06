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
  body: unknown;
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

  test("prints top-level help successfully", async () => {
    const result = await runCli(["--help"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("userland --version");
    expect(result.stdout).toContain("userland apps publish");
    expect(result.stdout).toContain("userland support open");
    expect(result.stdout).toContain("userland validate <dir> [--plan <plan>] [--strict] [--json]");
    expect(result.stdout).toContain("--skip-local-validation");
    expect(result.stdout).toContain("userland apps analytics <app-id> [--range 7d|30d|90d] [--account <account-id>] [--json]");
    expect(result.stdout).toContain("userland analytics <app-id>");
    expect(result.stdout).toContain("userland apps unpublish <app-id> [--yes] [--account <account-id>] [--json]");
    expect(result.stdout).toContain("userland apps secrets list <app-id> [--account <account-id>] [--json]");
    expect(result.stdout).toContain("userland apps secrets delete <app-id> <NAME> [--yes] [--account <account-id>]");
    expect(result.stdout).toContain(
      "userland apps invites create <app-id> --email <email> [--role <role>]... [--expires-in-days <1-30>] [--account <account-id>] [--json]"
    );
    expect(result.stdout).toContain("[--limit <n>] [--cursor <cursor>] [--account <account-id>]");
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
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/limits": limitsResponse("acct_owner", "free"),
      "PUT /v0/apps": {
        status: "published",
        app_id: "app_hello",
        release_id: "rel_hello",
        origin: "https://app_hello.apps.userland.fun/",
        previous_release_id: null,
        activation: {
          status: "live",
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
    expect(result.stdout).toContain("local_validation=passed\nlocal_validation_plan=free\nlocal_validation_plan_source=account");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /v0/accounts",
      "GET /v0/accounts/acct_owner/limits",
      "PUT /v0/apps"
    ]);
    const publish = requests[2];
    expect(publish.authorization).toBe("Bearer test_api_key");
    expect(publish.accountId).toBeUndefined();

    const body = publish.body as { files?: Array<{ path: string; content_base64: string }>; message?: string };
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
    expect(index).toBeDefined();
    expect(Buffer.from(index?.content_base64 ?? "", "base64").toString("utf8")).toContain("Hello from Userland");
  });

  test.each(activationFixture.cases.map((entry) => [entry.name, entry] as const))(
    "prints the truthful publish result for %s, and exits 0",
    async (_name, entry) => {
      const requests: RequestRecord[] = [];
      const appRoute = entry.args.includes("--app") ? `PUT /v0/apps/${entry.response.app_id}` : "PUT /v0/apps";
      const api = await startMockApi(requests, { [appRoute]: entry.response });

      const result = await runCli(["apps", "publish", "examples/hello-static", "--skip-local-validation", ...entry.args], api.baseUrl, {
        env: { USERLAND_CONSOLE_URL: "https://console.example.test/" }
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(["local_validation=skipped", ...entry.stdout_lines, ""].join("\n"));
      // "Published" appears only when the new release serves.
      expect(result.stdout.includes("Published ")).toBe(entry.meaning.live);
      expect(result.stdout.includes("not live")).toBe(!entry.meaning.live);
      expect(result.stdout.includes("is still live at")).toBe(entry.meaning.serving === "previous_release");
      for (const name of entry.meaning.missing_secrets) {
        expect(result.stdout).toContain(`userland apps secrets set app_fixture ${name}\n`);
      }
    }
  );

  test("suggests commands that keep --account and quote the folder, and links to the console only when it is known", async () => {
    const requests: RequestRecord[] = [];
    const pending = activationFixture.cases.find((entry) => entry.name === "pending_secrets_update")?.response;
    const api = await startMockApi(requests, { "PUT /v0/apps/app_fixture": pending });
    const dir = await temporaryAppDir({ app: { name: "Spaced" }, runtime: { static_root: "public" } });
    const spaced = path.join(dir, "my app's folder");
    await fs.rename(path.join(dir, "public"), path.join(dir, "keep-public"));
    await fs.mkdir(spaced);
    await fs.rename(path.join(dir, "manifest.userland.json"), path.join(spaced, "manifest.userland.json"));
    await fs.rename(path.join(dir, "keep-public"), path.join(spaced, "public"));

    const result = await runCli(["apps", "publish", spaced, "--skip-local-validation", "--app", "app_fixture", "--account", "acct_owner"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Next: printf '%s' "$VALUE" | userland apps secrets set app_fixture STRIPE_SECRET_KEY --account acct_owner\n`);
    expect(result.stdout).toContain(`Next: userland apps publish '${spaced.replaceAll("'", `'\\''`)}' --app app_fixture --account acct_owner\n`);
    // A local API has no known console, so there is no add-key link.
    expect(result.stdout).not.toContain("add-key=");
  });

  test("still says a release is not live when an older API leaves out missing_secrets", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "PUT /v0/apps": {
        status: "stored",
        app_id: "app_old_api",
        release_id: "rel_new",
        origin: "https://app_old_api.apps.userland.fun/",
        previous_release_id: null,
        activation: { status: "pending_secrets", reasons: ["Required secret API_TOKEN is not set."], previous_release_id: null }
      }
    });

    const result = await runCli(["apps", "publish", "examples/hello-static", "--skip-local-validation"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stored, not live: this release is not serving yet.\nWhy: Required secret API_TOKEN is not set.\n");
    expect(result.stdout).toContain("Next: userland apps publish examples/hello-static --app app_old_api\n");
    expect(result.stdout).not.toContain("Published");
    expect(result.stdout).not.toContain("secrets set");
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
            activation_status: "live",
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
        status: "rolled_back"
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

  test("unpublishes an app with --yes without asking", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "DELETE /v0/apps/app_dummy": unpublishResponse("app_dummy")
    });

    // With no account selected there is nothing to check, so only the DELETE is sent.
    const result = await runCli(["apps", "unpublish", "app_dummy", "--yes"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "Unpublished app_dummy\napp_id=app_dummy\nstatus=unpublished\ndeleted_at=2026-09-28T00:00:00.000Z\n" +
        "The app is offline and its slugs and custom domains are removed. Its release history is kept.\n"
    );
    expect(result.stderr).toBe("");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["DELETE /v0/apps/app_dummy"]);
    expect(requests[0].authorization).toBe("Bearer test_api_key");
    expect(requests[0].accountId).toBeUndefined();

    // -y is the short form; --json prints the API response unchanged.
    const json = await runCli(["apps", "unpublish", "app_dummy", "-y", "--json"], api.baseUrl);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(unpublishResponse("app_dummy"));
    expect(json.stderr).toBe("");
    expect(requests).toHaveLength(2);
  });

  test("with an account selected, unpublishes only an app in that account, even with --yes", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": appResponse("app_dummy", "Dummy app"),
      "DELETE /v0/apps/app_dummy": unpublishResponse("app_dummy"),
      "GET /v0/apps/app_legacy": { ...appResponse("app_legacy", "Legacy app"), account_id: null },
      "DELETE /v0/apps/app_legacy": { __status: 403, error: { code: "forbidden", message: "App account access is required." } }
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_base_url: api.baseUrl, account_id: "acct_sandbox" }));

    // The app belongs to acct_owner. Every way of selecting another account stops before the DELETE.
    const mismatches: Array<{ label: string; args: string[]; options: Parameters<typeof runCli>[2] }> = [
      { label: "--account with --yes", args: ["--yes", "--account", "acct_sandbox"], options: {} },
      { label: "--account with --yes --json", args: ["--yes", "--json", "--account", "acct_sandbox"], options: {} },
      { label: "USERLAND_ACCOUNT_ID with --yes", args: ["--yes"], options: { accountId: "acct_sandbox" } },
      { label: "saved account with --yes", args: ["--yes"], options: { apiKey: null, credentialsFile } },
      { label: "--account in a terminal", args: ["--account", "acct_sandbox"], options: { tty: true, stdin: "y\n" } }
    ];
    for (const { label, args, options } of mismatches) {
      requests.length = 0;
      const result = await runCli(["apps", "unpublish", "app_dummy", ...args], api.baseUrl, options);
      expect(result.code, label).toBe(1);
      expect(result.stdout, label).toBe("");
      expect(result.stderr, label).toBe(
        "app_dummy belongs to account acct_owner, not acct_sandbox. Nothing was unpublished.\n" +
          "Check the app id with `userland apps list`. If you meant the other account, pass --account acct_owner.\n"
      );
      expect(calls(), label).toEqual(["GET /v0/apps/app_dummy"]);
      expect(requests[0].accountId, label).toBe("acct_sandbox");
    }

    // --account wins over USERLAND_ACCOUNT_ID and the saved account, as in other commands.
    requests.length = 0;
    const matching = await runCli(["apps", "unpublish", "app_dummy", "--yes", "--account", "acct_owner"], api.baseUrl, {
      apiKey: null,
      credentialsFile,
      accountId: "acct_sandbox"
    });
    expect(matching.code).toBe(0);
    expect(matching.stderr).toBe("");
    expect(matching.stdout).toBe(
      "Unpublished Dummy app (https://app_dummy.apps.userland.fun/)\napp_id=app_dummy\nstatus=unpublished\n" +
        "deleted_at=2026-09-28T00:00:00.000Z\nThe app is offline and its slugs and custom domains are removed. Its release history is kept.\n"
    );
    expect(calls()).toEqual(["GET /v0/apps/app_dummy", "DELETE /v0/apps/app_dummy"]);
    expect(requests.map((request) => request.accountId)).toEqual(["acct_owner", "acct_owner"]);

    requests.length = 0;
    const matchingEnv = await runCli(["apps", "unpublish", "app_dummy", "--yes", "--json"], api.baseUrl, { accountId: "acct_owner" });
    expect(matchingEnv.code).toBe(0);
    expect(JSON.parse(matchingEnv.stdout)).toEqual(unpublishResponse("app_dummy"));
    expect(calls()).toEqual(["GET /v0/apps/app_dummy", "DELETE /v0/apps/app_dummy"]);

    // An app with no account is left to the API, which refuses to unpublish it.
    requests.length = 0;
    const legacy = await runCli(["apps", "unpublish", "app_legacy", "--yes", "--account", "acct_sandbox"], api.baseUrl);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain("API 403: App account access is required.");
    expect(calls()).toEqual(["GET /v0/apps/app_legacy", "DELETE /v0/apps/app_legacy"]);
  });

  test("refuses to unpublish without --yes when there is no terminal to confirm in", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": appResponse("app_dummy", "Dummy app"),
      "DELETE /v0/apps/app_dummy": unpublishResponse("app_dummy")
    });

    // Piping an answer is not a terminal either: scripts and agents must pass --yes.
    for (const stdin of [undefined, "y\n", "app_dummy\n"]) {
      const result = await runCli(["apps", "unpublish", "app_dummy"], api.baseUrl, { stdin });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Unpublishing takes the app offline and removes its slugs and custom domains.\n" +
          "There is no terminal to confirm in, so check with the app's owner first, then run: userland apps unpublish app_dummy --yes\n"
      );
      expect(result.stderr).toContain("Usage: userland apps unpublish <app-id> [--yes] [--account <account-id>] [--json]");
    }

    // The suggested command keeps --account, so running it still checks the app's account.
    const withAccount = await runCli(["apps", "unpublish", "app_dummy", "--account", "acct_owner"], api.baseUrl);
    expect(withAccount.code).toBe(1);
    expect(withAccount.stdout).toBe("");
    expect(withAccount.stderr).toContain(
      "There is no terminal to confirm in, so check with the app's owner first, then run: userland apps unpublish app_dummy --yes --account acct_owner\n"
    );

    for (const args of [["apps", "unpublish"], ["apps", "unpublish", "--yes"], ["apps", "unpublish", "-y", "app_dummy"]]) {
      const result = await runCli(args, api.baseUrl);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("Usage: userland apps unpublish <app-id>");
    }

    const unknown = await runCli(["apps", "unpublish", "app_dummy", "--force"], api.baseUrl);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown option: --force");

    const emptyAccount = await runCli(["apps", "unpublish", "app_dummy", "--yes", "--account", ""], api.baseUrl);
    expect(emptyAccount.code).toBe(1);
    expect(emptyAccount.stderr).toContain("--account requires a value, but it was empty.");

    expect(requests).toHaveLength(0);
  });

  test("asks for the app id or y before unpublishing in a terminal", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": appResponse("app_dummy", "Dummy app"),
      "DELETE /v0/apps/app_dummy": unpublishResponse("app_dummy")
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);

    const byId = await runCli(["apps", "unpublish", "app_dummy"], api.baseUrl, { tty: true, stdin: "app_dummy\n" });
    expect(byId.code).toBe(0);
    expect(byId.stderr).toBe(
      "You are about to unpublish this app:\n" +
        "  Name:        Dummy app\n" +
        "  Address:     https://app_dummy.apps.userland.fun/\n" +
        "  App id:      app_dummy\n" +
        "  Account:     acct_owner\n" +
        "  Production:  no\n" +
        "Unpublishing takes the app offline and removes its slugs and custom domains. Its release history is kept.\n" +
        "Type the app id (app_dummy) or y to unpublish it: "
    );
    expect(byId.stdout).toContain("Unpublished Dummy app (https://app_dummy.apps.userland.fun/)\napp_id=app_dummy\nstatus=unpublished\n");
    expect(calls()).toEqual(["GET /v0/apps/app_dummy", "DELETE /v0/apps/app_dummy"]);

    for (const answer of ["y\n", "Y\n", "yes\n", "  app_dummy  \n"]) {
      requests.length = 0;
      const result = await runCli(["apps", "unpublish", "app_dummy"], api.baseUrl, { tty: true, stdin: answer });
      expect(result.code, JSON.stringify(answer)).toBe(0);
      expect(calls(), JSON.stringify(answer)).toEqual(["GET /v0/apps/app_dummy", "DELETE /v0/apps/app_dummy"]);
    }

    // Anything else, including no answer at all (input closed), cancels without sending the DELETE.
    for (const answer of ["n\n", "\n", "app_other\n", "APP_DUMMY\n", "", "y"]) {
      requests.length = 0;
      const result = await runCli(["apps", "unpublish", "app_dummy"], api.baseUrl, { tty: true, stdin: answer });
      expect(result.code, JSON.stringify(answer)).toBe(1);
      expect(result.stdout, JSON.stringify(answer)).toBe("");
      expect(result.stderr, JSON.stringify(answer)).toContain("Cancelled. app_dummy was not unpublished.");
      expect(calls(), JSON.stringify(answer)).toEqual(["GET /v0/apps/app_dummy"]);
    }

    // With --json the prompt stays on stderr, so stdout is only the API response.
    requests.length = 0;
    const json = await runCli(["apps", "unpublish", "app_dummy", "--json", "--account", "acct_owner"], api.baseUrl, { tty: true, stdin: "y\n" });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(unpublishResponse("app_dummy"));
    expect(json.stderr).toContain("Type the app id (app_dummy) or y to unpublish it: ");
    expect(requests.map((request) => request.accountId)).toEqual(["acct_owner", "acct_owner"]);

    // A production app says so in the prompt.
    requests.length = 0;
    const productionApi = await startMockApi(requests, {
      "GET /v0/apps/app_live": { ...appResponse("app_live", "Live app"), production: true }
    });
    const production = await runCli(["apps", "unpublish", "app_live"], productionApi.baseUrl, { tty: true, stdin: "n\n" });
    expect(production.code).toBe(1);
    expect(production.stderr).toContain("  Account:     acct_owner\n  Production:  yes\n");
    expect(calls()).toEqual(["GET /v0/apps/app_live"]);
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

  test("shows app names from the API with control characters escaped in the unpublish prompt", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": appResponse("app_dummy", "Dummy\u001b[2J app")
    });

    const result = await runCli(["apps", "unpublish", "app_dummy"], api.baseUrl, { tty: true, stdin: "n\n" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("  Name:        Dummy\\x1b[2J app\n");
    expect(result.stderr).not.toContain("\u001b");

    const oddAccountApi = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": { ...appResponse("app_dummy", "Dummy app"), account_id: "acct\u001b[2Jother" }
    });
    const mismatch = await runCli(["apps", "unpublish", "app_dummy", "--yes", "--account", "acct_sandbox"], oddAccountApi.baseUrl);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("app_dummy belongs to account acct\\x1b[2Jother, not acct_sandbox. Nothing was unpublished.");
    expect(mismatch.stderr).not.toContain("\u001b");
    expect(requests.map((request) => request.method)).not.toContain("DELETE");
  });

  test("reports not found, forbidden, and takedown errors when unpublishing", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "DELETE /v0/apps/app_missing": { __status: 404, error: { code: "not_found", message: "App not found." } },
      "DELETE /v0/apps/app_viewer": { __status: 403, error: { code: "forbidden", message: "Your account role cannot perform this operation." } },
      "DELETE /v0/apps/app_legal": {
        __status: 451,
        error: { code: "app_takedown", message: "This app is unavailable for legal reasons.", details: { app_id: "app_legal", reasons: [] } }
      },
      "GET /v0/apps/app_missing": { __status: 404, error: { code: "not_found", message: "App not found." } }
    });

    const cases = [
      { appId: "app_missing", message: "API 404: App not found.\nerror=not_found" },
      { appId: "app_viewer", message: "API 403: Your account role cannot perform this operation.\nerror=forbidden" },
      { appId: "app_legal", message: "API 451: This app is unavailable for legal reasons.\nerror=app_takedown" }
    ];
    for (const { appId, message } of cases) {
      for (const extra of [[], ["--json"]]) {
        const result = await runCli(["apps", "unpublish", appId, "--yes", ...extra], api.baseUrl);
        expect(result.code, `${appId} ${extra.join(" ")}`).toBe(1);
        expect(result.stdout, `${appId} ${extra.join(" ")}`).toBe("");
        expect(result.stderr, `${appId} ${extra.join(" ")}`).toContain(message);
      }
    }

    // In a terminal, an app that cannot be read stops before the prompt and before any DELETE.
    requests.length = 0;
    const missing = await runCli(["apps", "unpublish", "app_missing"], api.baseUrl, { tty: true, stdin: "y\n" });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("API 404: App not found.\nerror=not_found");
    expect(missing.stderr).not.toContain("You are about to unpublish");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/apps/app_missing"]);
  });

  test("lists secret names and dates, never values", async () => {
    const requests: RequestRecord[] = [];
    // A response that carried a value must still never print it.
    const listed = secretsResponse("app_ops", ["MODEL_API_KEY", "STRIPE_SECRET_KEY"]);
    const withValues = {
      ...listed,
      secrets: listed.secrets.map((secret) => ({ ...secret, value: `leaked-${secret.name}`, encrypted_value: "ciphertext" }))
    };
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_ops/secrets": [withValues, withValues, withValues],
      "GET /v0/apps/app_empty/secrets": secretsResponse("app_empty", [])
    });

    const human = await runCli(["apps", "secrets", "list", "app_ops"], api.baseUrl);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(
      "MODEL_API_KEY\t2026-09-01T00:00:00.000Z\t2026-09-20T00:00:00.000Z\n" +
        "STRIPE_SECRET_KEY\t2026-09-01T00:00:00.000Z\t2026-09-20T00:00:00.000Z\n"
    );
    expect(human.stderr).toBe("");

    const json = await runCli(["apps", "secrets", "list", "app_ops", "--json", "--account", "acct_owner"], api.baseUrl);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      app_id: "app_ops",
      secrets: [
        { name: "MODEL_API_KEY", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" },
        { name: "STRIPE_SECRET_KEY", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" }
      ]
    });
    expect(requests.at(-1)?.accountId).toBe("acct_owner");

    // The key saved by `userland login` works as well as USERLAND_API_KEY.
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_base_url: api.baseUrl }));
    const saved = await runCli(["apps", "secrets", "list", "app_ops"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(saved.code).toBe(0);
    expect(requests.at(-1)?.authorization).toBe("Bearer saved_key");

    for (const output of [human.stdout, json.stdout, saved.stdout]) {
      expect(output).not.toContain("leaked-");
      expect(output).not.toContain("ciphertext");
    }

    // No secrets: stdout stays empty for scripts, and stderr says so.
    const empty = await runCli(["apps", "secrets", "list", "app_empty"], api.baseUrl);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe("");
    expect(empty.stderr).toBe("No secrets are set for app_empty.\n");
    const emptyJson = await runCli(["apps", "secrets", "list", "app_empty", "--json"], api.baseUrl);
    expect(JSON.parse(emptyJson.stdout)).toEqual({ app_id: "app_empty", secrets: [] });
    expect(emptyJson.stderr).toBe("");

    requests.length = 0;
    for (const args of [["apps", "secrets", "list"], ["apps", "secrets", "list", "--json"]]) {
      const result = await runCli(args, api.baseUrl);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("Usage: userland apps secrets list <app-id> [--account <account-id>] [--json]");
    }
    const unknown = await runCli(["apps", "secrets", "list", "app_ops", "--values"], api.baseUrl);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown option: --values");
    expect(requests).toHaveLength(0);
  });

  test("deletes a secret with --yes without asking, only when it is set", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy/secrets": secretsResponse("app_dummy", ["MODEL_API_KEY", "OPENAI_API_KEY"]),
      "DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY": { name: "OPENAI_API_KEY", present: false },
      "DELETE /v0/apps/app_dummy/secrets/OPENAI_KEY": { name: "OPENAI_KEY", present: false }
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);

    // With no account selected there is nothing to check about the app; the CLI checks the name is set.
    const result = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY", "--yes"], api.baseUrl);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "Deleted secret OPENAI_API_KEY from app_dummy.\nsecret=OPENAI_API_KEY\npresent=false\n" +
        "Server code that reads OPENAI_API_KEY no longer gets it. If manifest.userland.json lists it under resources.secrets.required, " +
        "remove it there too, or the next release you publish does not go live (pending_secrets) until the secret is set and you publish again.\n"
    );
    expect(result.stderr).toBe("");
    expect(calls()).toEqual(["GET /v0/apps/app_dummy/secrets", "DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY"]);
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer test_api_key", "Bearer test_api_key"]);

    // The API answers a DELETE the same way whether or not the name was set, so a name that is not set
    // (such as a typo) is refused before the DELETE instead of reported as deleted.
    requests.length = 0;
    const typo = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_KEY", "-y"], api.baseUrl);
    expect(typo.code).toBe(1);
    expect(typo.stdout).toBe("");
    expect(typo.stderr).toContain(
      "No secret named OPENAI_KEY is set for app_dummy, so nothing was deleted. See the names that are set with: userland apps secrets list app_dummy"
    );
    expect(typo.stderr).toContain("Docs: https://docs.userland.fun/guides/secrets");
    expect(calls()).toEqual(["GET /v0/apps/app_dummy/secrets"]);
  });

  test("refuses to delete a secret without --yes when there is no terminal to confirm in", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": appResponse("app_dummy", "Dummy app"),
      "GET /v0/apps/app_dummy/secrets": secretsResponse("app_dummy", ["OPENAI_API_KEY"]),
      "DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY": { name: "OPENAI_API_KEY", present: false }
    });

    // Piping an answer is not a terminal either: scripts and agents must pass --yes.
    for (const stdin of [undefined, "y\n", "OPENAI_API_KEY\n"]) {
      const result = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY"], api.baseUrl, { stdin });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Deleting a secret removes its value from the app at once. It cannot be brought back, only set again.\n" +
          "There is no terminal to confirm in, so check with the app's owner first, then run: userland apps secrets delete app_dummy OPENAI_API_KEY --yes\n" +
          "Usage: userland apps secrets delete <app-id> <NAME> [--yes] [--account <account-id>]\n"
      );
    }

    // The suggested command keeps --account, so running it still checks the app's account before the
    // DELETE (with --yes and no account selected, the CLI does not read the app first).
    const withAccount = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY", "--account", "acct_owner"], api.baseUrl);
    expect(withAccount.code).toBe(1);
    expect(withAccount.stdout).toBe("");
    expect(withAccount.stderr).toBe(
      "Deleting a secret removes its value from the app at once. It cannot be brought back, only set again.\n" +
        "There is no terminal to confirm in, so check with the app's owner first, then run: userland apps secrets delete app_dummy OPENAI_API_KEY --yes --account acct_owner\n" +
        "Usage: userland apps secrets delete <app-id> <NAME> [--yes] [--account <account-id>]\n"
    );

    for (const args of [
      ["apps", "secrets", "delete"],
      ["apps", "secrets", "delete", "app_dummy"],
      ["apps", "secrets", "delete", "app_dummy", "--yes"],
      ["apps", "secrets", "delete", "--yes", "app_dummy", "OPENAI_API_KEY"]
    ]) {
      const result = await runCli(args, api.baseUrl);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("Usage: userland apps secrets delete <app-id> <NAME>");
    }

    const unknown = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY", "--force"], api.baseUrl);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown option: --force");

    const emptyAccount = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY", "--yes", "--account", ""], api.baseUrl);
    expect(emptyAccount.code).toBe(1);
    expect(emptyAccount.stderr).toContain("--account requires a value, but it was empty.");

    expect(requests).toHaveLength(0);
  });

  test("asks for the secret name or y before deleting a secret in a terminal", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": appResponse("app_dummy", "Dummy\u001b[2J app"),
      "GET /v0/apps/app_dummy/secrets": secretsResponse("app_dummy", ["OPENAI_API_KEY"]),
      "DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY": { name: "OPENAI_API_KEY", present: false }
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);

    const byName = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY"], api.baseUrl, { tty: true, stdin: "OPENAI_API_KEY\n" });
    expect(byName.code).toBe(0);
    expect(byName.stderr).toBe(
      "You are about to delete this secret:\n" +
        "  Secret:      OPENAI_API_KEY\n" +
        "  Last set:    2026-09-20T00:00:00.000Z\n" +
        "  App:         Dummy\\x1b[2J app\n" +
        "  Address:     https://app_dummy.apps.userland.fun/\n" +
        "  App id:      app_dummy\n" +
        "  Account:     acct_owner\n" +
        "Server code that reads OPENAI_API_KEY stops getting it at once. The value cannot be shown or brought back; you can only set a new one.\n" +
        "Type the secret name (OPENAI_API_KEY) or y to delete it: "
    );
    expect(byName.stdout).toContain("Deleted secret OPENAI_API_KEY from app_dummy.\nsecret=OPENAI_API_KEY\npresent=false\n");
    expect(calls()).toEqual(["GET /v0/apps/app_dummy", "GET /v0/apps/app_dummy/secrets", "DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY"]);

    for (const answer of ["y\n", "YES\n", "  OPENAI_API_KEY  \n"]) {
      requests.length = 0;
      const result = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY"], api.baseUrl, { tty: true, stdin: answer });
      expect(result.code, JSON.stringify(answer)).toBe(0);
      expect(calls().at(-1), JSON.stringify(answer)).toBe("DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY");
    }

    // Anything else, including no answer at all (input closed), cancels without sending the DELETE.
    for (const answer of ["n\n", "\n", "openai_api_key\n", "MODEL_API_KEY\n", ""]) {
      requests.length = 0;
      const result = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY"], api.baseUrl, { tty: true, stdin: answer });
      expect(result.code, JSON.stringify(answer)).toBe(1);
      expect(result.stdout, JSON.stringify(answer)).toBe("");
      expect(result.stderr, JSON.stringify(answer)).toContain("Cancelled. OPENAI_API_KEY was not deleted.");
      expect(calls(), JSON.stringify(answer)).toEqual(["GET /v0/apps/app_dummy", "GET /v0/apps/app_dummy/secrets"]);
    }

    // A name that is not set stops before the prompt.
    requests.length = 0;
    const notSet = await runCli(["apps", "secrets", "delete", "app_dummy", "MODEL_API_KEY"], api.baseUrl, { tty: true, stdin: "y\n" });
    expect(notSet.code).toBe(1);
    expect(notSet.stderr).toContain("No secret named MODEL_API_KEY is set for app_dummy, so nothing was deleted.");
    expect(notSet.stderr).not.toContain("You are about to delete");
    expect(calls()).toEqual(["GET /v0/apps/app_dummy", "GET /v0/apps/app_dummy/secrets"]);
  });

  test("with an account selected, deletes a secret only in an app of that account, even with --yes", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_dummy": appResponse("app_dummy", "Dummy app"),
      "GET /v0/apps/app_dummy/secrets": secretsResponse("app_dummy", ["OPENAI_API_KEY"]),
      "DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY": { name: "OPENAI_API_KEY", present: false }
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_base_url: api.baseUrl, account_id: "acct_sandbox" }));

    // The app belongs to acct_owner. Every way of selecting another account stops before the DELETE.
    const mismatches: Array<{ label: string; args: string[]; options: Parameters<typeof runCli>[2] }> = [
      { label: "--account with --yes", args: ["--yes", "--account", "acct_sandbox"], options: {} },
      { label: "USERLAND_ACCOUNT_ID with --yes", args: ["--yes"], options: { accountId: "acct_sandbox" } },
      { label: "saved account with --yes", args: ["--yes"], options: { apiKey: null, credentialsFile } },
      { label: "--account in a terminal", args: ["--account", "acct_sandbox"], options: { tty: true, stdin: "y\n" } }
    ];
    for (const { label, args, options } of mismatches) {
      requests.length = 0;
      const result = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY", ...args], api.baseUrl, options);
      expect(result.code, label).toBe(1);
      expect(result.stdout, label).toBe("");
      expect(result.stderr, label).toBe(
        "app_dummy belongs to account acct_owner, not acct_sandbox. Nothing was deleted.\n" +
          "Check the app id with `userland apps list`. If you meant the other account, pass --account acct_owner.\n"
      );
      expect(calls(), label).toEqual(["GET /v0/apps/app_dummy"]);
    }

    // The matching account goes ahead, with the saved login's key and the account on every request.
    requests.length = 0;
    const matching = await runCli(["apps", "secrets", "delete", "app_dummy", "OPENAI_API_KEY", "--yes", "--account", "acct_owner"], api.baseUrl, {
      apiKey: null,
      credentialsFile
    });
    expect(matching.code).toBe(0);
    expect(matching.stderr).toBe("");
    expect(calls()).toEqual(["GET /v0/apps/app_dummy", "GET /v0/apps/app_dummy/secrets", "DELETE /v0/apps/app_dummy/secrets/OPENAI_API_KEY"]);
    expect(requests.map((request) => request.accountId)).toEqual(["acct_owner", "acct_owner", "acct_owner"]);
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer saved_key", "Bearer saved_key", "Bearer saved_key"]);
  });

  test("refuses secret names the API refuses before sending anything", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {});

    const cases: Array<{ name: string; message: string }> = [
      { name: "USERLAND_TOKEN", message: "Invalid secret name: USERLAND_TOKEN. Secret names cannot start with USERLAND_, CF_, or CLOUDFLARE_, which are kept for Userland." },
      { name: "CF_API_TOKEN", message: "Invalid secret name: CF_API_TOKEN. Secret names cannot start with USERLAND_, CF_, or CLOUDFLARE_, which are kept for Userland." },
      { name: "CLOUDFLARE_KEY", message: "Invalid secret name: CLOUDFLARE_KEY. Secret names cannot start with USERLAND_, CF_, or CLOUDFLARE_, which are kept for Userland." },
      { name: "openai_api_key", message: "Invalid secret name: openai_api_key. Secret names use capital letters" },
      { name: "1KEY", message: "Invalid secret name: 1KEY." },
      { name: `K${"X".repeat(64)}`, message: "Invalid secret name: KXXX" }
    ];
    for (const { name, message } of cases) {
      for (const args of [
        ["apps", "secrets", "delete", "app_1", name, "--yes"],
        ["apps", "secrets", "delete", "app_1", name],
        ["apps", "secrets", "set", "app_1", name]
      ]) {
        const result = await runCli(args, api.baseUrl, { stdin: "value" });
        expect(result.code, args.join(" ")).toBe(1);
        expect(result.stderr, args.join(" ")).toContain(message);
      }
    }
    // CF and USERLAND without the underscore are ordinary names.
    const ordinary = await runCli(["apps", "secrets", "delete", "app_1", "CFO_EMAIL", "--yes"], api.baseUrl);
    expect(ordinary.stderr).not.toContain("Invalid secret name");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/apps/app_1/secrets"]);
  });

  test("creates an app sign-in invite and prints only the link", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_portal": appResponse("app_portal", "Staff portal"),
      "POST /v0/apps/app_portal/admin-invites": [inviteResponse(["staff", "owner"]), inviteResponse([]), inviteResponse(["staff"]), inviteResponse(["staff"])]
    });
    const posts = () => requests.filter((request) => request.method === "POST");

    // --role repeats; each role is sent once, in order. --expires-in-days becomes expires_in_seconds.
    const result = await runCli(
      ["apps", "invites", "create", "app_portal", "--email", "jo@example.com", "--role", "staff", "--role", "owner", "--role", "staff", "--expires-in-days", "30", "--account", "acct_owner"],
      api.baseUrl
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("https://app_portal.apps.userland.fun/_userland/auth/invite/inv_1?token=inv_abc\n");
    expect(result.stderr).toBe("");
    // With an account selected, the CLI first checks the app belongs to it.
    expect(requests[0]).toMatchObject({ method: "GET", url: "/v0/apps/app_portal", accountId: "acct_owner" });
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: "/v0/apps/app_portal/admin-invites",
      authorization: "Bearer test_api_key",
      accountId: "acct_owner",
      body: { email: "jo@example.com", roles: ["staff", "owner"], expires_in_seconds: 2592000 }
    });

    // No --role means no special role, and no --expires-in-days leaves the API's 7 days. The key saved
    // by `userland login` works, so agents do not need to make another API key.
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_base_url: api.baseUrl, account_id: "acct_owner" }));
    const saved = await runCli(["apps", "invites", "create", "app_portal", "--email", " jo@example.com "], api.baseUrl, { apiKey: null, credentialsFile });
    expect(saved.code).toBe(0);
    expect(saved.stdout).toBe("https://app_portal.apps.userland.fun/_userland/auth/invite/inv_1?token=inv_abc\n");
    expect(requests[2]).toMatchObject({ method: "GET", url: "/v0/apps/app_portal", authorization: "Bearer saved_key", accountId: "acct_owner" });
    expect(requests[3]).toMatchObject({ method: "POST", authorization: "Bearer saved_key", accountId: "acct_owner", body: { email: "jo@example.com", roles: [] } });

    // With no account selected there is nothing to check, so only the POST is sent.
    const oneDay = await runCli(["apps", "invites", "create", "app_portal", "--role", "staff", "--email", "jo@example.com", "--expires-in-days", "1"], api.baseUrl);
    expect(oneDay.code).toBe(0);
    expect(requests).toHaveLength(5);
    expect(requests[4]).toMatchObject({ method: "POST", accountId: undefined, body: { email: "jo@example.com", roles: ["staff"], expires_in_seconds: 86400 } });

    // --json prints the API response unchanged.
    const json = await runCli(["apps", "invites", "create", "app_portal", "--email", "jo@example.com", "--role", "staff", "--json"], api.baseUrl);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(inviteResponse(["staff"]));
    expect(json.stderr).toBe("");
    expect(requests).toHaveLength(6);
    expect(posts()).toHaveLength(4);
  });

  test("with an account selected, creates an invite only for an app in that account", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_portal": appResponse("app_portal", "Staff portal"),
      "POST /v0/apps/app_portal/admin-invites": inviteResponse([])
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_base_url: api.baseUrl, account_id: "acct_sandbox" }));

    // The app belongs to acct_owner. Every way of selecting another account stops before the POST.
    const mismatches: Array<{ label: string; args: string[]; options: Parameters<typeof runCli>[2] }> = [
      { label: "--account", args: ["--account", "acct_sandbox"], options: {} },
      { label: "--account with --json", args: ["--account", "acct_sandbox", "--json"], options: {} },
      { label: "USERLAND_ACCOUNT_ID", args: [], options: { accountId: "acct_sandbox" } },
      { label: "saved account", args: [], options: { apiKey: null, credentialsFile } }
    ];
    for (const { label, args, options } of mismatches) {
      requests.length = 0;
      const result = await runCli(["apps", "invites", "create", "app_portal", "--email", "jo@example.com", ...args], api.baseUrl, options);
      expect(result.code, label).toBe(1);
      expect(result.stdout, label).toBe("");
      expect(result.stderr, label).toBe(
        "app_portal belongs to account acct_owner, not acct_sandbox. No invite was created.\n" +
          "Check the app id with `userland apps list`. If you meant the other account, pass --account acct_owner.\n"
      );
      expect(calls(), label).toEqual(["GET /v0/apps/app_portal"]);
    }
  });

  test("checks invite options before sending anything", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {});
    const usageLine =
      "Usage: userland apps invites create <app-id> --email <email> [--role <role>]... [--expires-in-days <1-30>] [--account <account-id>] [--json]";

    const cases: Array<{ args: string[]; message: string }> = [
      { args: ["apps", "invites", "create"], message: usageLine },
      { args: ["apps", "invites", "create", "--email", "jo@example.com"], message: usageLine },
      { args: ["apps", "invites", "create", "app_portal"], message: "--email is required: the email address of the person to invite." },
      { args: ["apps", "invites", "create", "app_portal", "--email", ""], message: "--email requires a value, but it was empty." },
      { args: ["apps", "invites", "create", "app_portal", "--email", "--role", "staff"], message: "--email requires a value." },
      { args: ["apps", "invites", "create", "app_portal", "--email", "jo@example.com", "--role", ""], message: "--role requires a value, but it was empty." },
      { args: ["apps", "invites", "create", "app_portal", "--email", "jo@example.com", "--role"], message: "--role requires a value." },
      {
        args: ["apps", "invites", "create", "app_portal", "--email", "jo@example.com", "--role", "staff,owner"],
        message: "Pass one role for each --role, for example --role staff --role owner, not --role staff,owner."
      },
      { args: ["apps", "invites", "create", "..", "--email", "jo@example.com"], message: 'Invalid app id: "..".' },
      { args: ["apps", "invites", "create", "app_portal", "--email", "jo@example.com", "--days", "3"], message: "Unknown option: --days" }
    ];
    for (const days of ["0", "31", "1.5", "7d", "-1", " "]) {
      cases.push({
        args: ["apps", "invites", "create", "app_portal", "--email", "jo@example.com", "--expires-in-days", days],
        message: days.trim() === "" ? "--expires-in-days requires a value, but it was empty." : `--expires-in-days must be a whole number of days from 1 to 30, not ${days}.`
      });
    }
    for (const { args, message } of cases) {
      const result = await runCli(args, api.baseUrl);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toContain(message);
    }
    expect(requests).toHaveLength(0);
  });

  test("prints invite errors from the API, such as the app's people limit, without an invite link", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/apps/app_full/admin-invites": {
        __status: 402,
        error: {
          code: "quota_exceeded",
          message: "app_users.active.max quota exceeded for the current plan.",
          details: {
            metric: "app_users.active.max",
            plan_key: "free",
            limit: 10,
            current: 10,
            increment: 1,
            required_plan_key: "starter",
            upgrade_required: true,
            self_serve_upgrade: true,
            docs_url: "https://docs.userland.fun/reference/limits/",
            upgrade_url: "https://console.userland.fun/billing/plans?plan=starter&for=app_users.active.max&account=acct_full"
          }
        }
      },
      "POST /v0/apps/app_static/admin-invites": { __status: 409, error: { code: "auth_disabled", message: "App-user auth is not enabled for this app." } },
      "POST /v0/apps/app_portal/admin-invites": { __status: 400, error: { code: "invalid_role", message: "Role manager is not declared for this app." } }
    });

    const full = await runCli(["apps", "invites", "create", "app_full", "--email", "jo@example.com"], api.baseUrl);
    expect(full.code).toBe(1);
    expect(full.stdout).toBe("");
    expect(full.stderr).toContain(
      "API 402: app_users.active.max quota exceeded for the current plan.\nerror=quota_exceeded\nmetric=app_users.active.max\nplan_key=free\n" +
        "required_plan_key=starter\nlimit=10\ncurrent=10\nincrement=1\nupgrade_required=true\nself_serve_upgrade=true\n" +
        "upgrade_url=https://console.userland.fun/billing/plans?plan=starter&for=app_users.active.max&account=acct_full\n"
    );

    for (const { appId, message } of [
      { appId: "app_static", message: "API 409: App-user auth is not enabled for this app.\nerror=auth_disabled\nDocs: https://docs.userland.fun/guides/auth\n" },
      { appId: "app_portal", message: "API 400: Role manager is not declared for this app.\nerror=invalid_role\nDocs: https://docs.userland.fun/guides/auth\n" }
    ]) {
      for (const extra of [[], ["--json"]]) {
        const result = await runCli(["apps", "invites", "create", appId, "--email", "jo@example.com", "--role", "manager", ...extra], api.baseUrl);
        expect(result.code, appId).toBe(1);
        expect(result.stdout, appId).toBe("");
        expect(result.stderr, appId).toBe(message);
      }
    }
  });

  test("pages through events with --cursor", async () => {
    const requests: RequestRecord[] = [];
    const event = (id: string, createdAt: string) => ({
      app_event_id: id,
      type: "runtime.error",
      severity: "error",
      message: `boom ${id}`,
      release_id: "rel_live",
      created_at: createdAt
    });
    const cursor = "eyJjcmVhdGVkX2F0IjoiMjAyNi0wOS0zMFQxMDowMDowMC4wMDBaIiwiYXBwX2V2ZW50X2lkIjoiZXZ0XzIifQ";
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_ops/events?severity=error&limit=2": {
        events: [event("evt_1", "2026-09-30T11:00:00.000Z"), event("evt_2", "2026-09-30T10:00:00.000Z")],
        cursor
      },
      [`GET /v0/apps/app_ops/events?severity=error&limit=2&cursor=${cursor}`]: {
        events: [event("evt_3", "2026-09-30T09:00:00.000Z")],
        cursor: null
      }
    });

    const first = await runCli(["apps", "events", "app_ops", "--severity", "error", "--limit", "2"], api.baseUrl);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(
      "2026-09-30T11:00:00.000Z\terror\truntime.error\trel_live\tboom evt_1\n" +
        "2026-09-30T10:00:00.000Z\terror\truntime.error\trel_live\tboom evt_2\n" +
        `cursor=${cursor}\n`
    );

    const second = await runCli(["apps", "events", "app_ops", "--severity", "error", "--limit", "2", "--cursor", cursor], api.baseUrl);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe("2026-09-30T09:00:00.000Z\terror\truntime.error\trel_live\tboom evt_3\n");

    const missing = await runCli(["apps", "events", "app_ops", "--cursor"], api.baseUrl);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--cursor requires a value.");
    const empty = await runCli(["apps", "events", "app_ops", "--cursor", "", "--limit", "2"], api.baseUrl);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("--cursor requires a value, but it was empty.");
    expect(requests.map((request) => request.url)).toEqual([
      "/v0/apps/app_ops/events?severity=error&limit=2",
      `/v0/apps/app_ops/events?severity=error&limit=2&cursor=${cursor}`
    ]);
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
        usage_limits: { "requests.monthly.max": 100000, "files.storage_bytes.max": 2147483648 },
        usage: { "requests.monthly.max": 42, "files.storage_bytes.max": 1288490188 },
        usage_sources: { "files.storage_bytes.max": "stored_files" },
        usage_period: { period_start: "2026-05-01T00:00:00.000Z", period_end: "2026-06-01T00:00:00.000Z" },
        route_counts: { active_custom_domains: 1 },
        short_address_holds: { held: 2, max: 5 },
        compatibility_warnings: []
      },
      "GET /v0/accounts/acct_unlimited/limits": {
        account_id: "acct_unlimited",
        plan_key: "internal",
        features: {},
        manifest_limits: {},
        deployment_limits: {},
        runtime_limits: {},
        release_limits: {},
        usage_limits: {},
        usage: {},
        short_address_holds: { held: 0, max: null }
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
    // Stored files are counted in total, not for this period, and usage_source says so.
    expect(limits.stdout).toContain("usage=files.storage_bytes.max value=1288490188\n");
    expect(limits.stdout).toContain("usage_source=files.storage_bytes.max value=stored_files\n");
    expect(limits.stdout).toContain("short_address_holds=held value=2\nshort_address_holds=max value=5\n");

    const unlimited = await runCli(["accounts", "limits", "--account", "acct_unlimited"], api.baseUrl);
    expect(unlimited.code).toBe(0);
    expect(unlimited.stdout).toContain("short_address_holds=held value=0\nshort_address_holds=max value=unlimited\n");
    expect(unlimited.stdout).not.toContain("usage_source=");

    const preview = await runCli(["accounts", "downgrade", "preview", "--to", "free", "--account", "acct_ops"], api.baseUrl);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("compatible=false");
    expect(preview.stdout).toContain("violation=type=deployment_limit key=custom_domains.max");

    // Plan aliases and casing are normalized before the request is sent.
    const aliased = await runCli(["accounts", "downgrade", "preview", "--to", " FREE ", "--account", "acct_ops"], api.baseUrl);
    expect(aliased.code).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: "GET", url: "/v0/accounts/acct_ops/downgrade-preview?plan=free" });
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
    // As the API answers a new custom domain: the records to add, and what the last check found.
    const dnsInstructions = {
      traffic: { type: "CNAME", name: "www.example.com", value: "customers.userland.fun" },
      cname: { type: "CNAME", name: "www.example.com", value: "customers.userland.fun" },
      ownership_txt: { type: "TXT", name: "_userland.www.example.com", value: "userland-route=route_domain" },
      ownership_status: "missing",
      provider: { name: "cloudflare", status: "pending", ssl_status: "pending_validation" },
      provider_validation_records: [
        { txt_name: "_acme-challenge.www.example.com", txt_value: "token-1" },
        { txt_name: "_acme-challenge.www.example.com", txt_value: "token-1" }
      ],
      verification_errors: ["Ownership TXT record not found: add _userland.www.example.com with the value userland-route=route_domain."],
      last_refreshed_at: "2026-05-05T00:00:00.000Z"
    };
    const dnsLines =
      "dns_record=traffic type=CNAME name=www.example.com value=customers.userland.fun\n" +
      "dns_record=ownership_txt type=TXT name=_userland.www.example.com value=userland-route=route_domain\n" +
      "dns_record=provider_validation type=TXT name=_acme-challenge.www.example.com value=token-1\n" +
      "dns_ownership_status=missing\n" +
      'dns_verification_error="Ownership TXT record not found: add _userland.www.example.com with the value userland-route=route_domain."\n' +
      "dns_last_refreshed_at=2026-05-05T00:00:00.000Z\n";
    const domainRoute = {
      ...route,
      route_id: "route_domain",
      route_type: "custom_domain",
      hostname: "www.example.com",
      slug: null,
      status: "pending_dns",
      verification: { method: "dns_txt", name: "_userland.www.example.com", value: "userland-route=route_domain", ownership_status: "missing" },
      dns_instructions: dnsInstructions
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
      "GET /v0/apps/app_ops/domains": { app_id: "app_ops", routes: [domainRoute] },
      "POST /v0/apps/app_ops/domains": { app_id: "app_ops", route: domainRoute },
      "POST /v0/apps/app_ops/domains/www.example.com/verify": { app_id: "app_ops", route: { ...route, route_type: "custom_domain", hostname: "www.example.com", slug: null } },
      "DELETE /v0/apps/app_ops/domains/www.example.com": {
        app_id: "app_ops",
        route: { ...domainRoute, status: "deleted", reason: "Route deleted.", deleted_at: "2026-05-06T00:00:00.000Z" }
      }
    });

    await expectCommand(["apps", "status", "app_ops", "--account", "acct_ops"], api.baseUrl, "can_serve_canonical=true");
    await expectCommand(["apps", "routes", "list", "app_ops", "--account", "acct_ops"], api.baseUrl, "route_slug\tslug\tactive");
    await expectCommand(["apps", "slugs", "list", "app_ops", "--account", "acct_ops"], api.baseUrl, "demo.apps.userland.fun");
    await expectCommand(["apps", "slugs", "add", "app_ops", "demo", "--account", "acct_ops"], api.baseUrl, "route_slug");
    expect(requests.at(-1)?.body).toEqual({ slug: "demo" });
    await expectCommand(["apps", "slugs", "remove", "app_ops", "demo", "--account", "acct_ops"], api.baseUrl, "deleted");
    await expectCommand(["apps", "domains", "list", "app_ops", "--account", "acct_ops"], api.baseUrl, "www.example.com");
    await expectCommand(
      ["apps", "domains", "add", "app_ops", "www.example.com", "--account", "acct_ops"],
      api.baseUrl,
      `route_domain\tcustom_domain\tpending_dns\twww.example.com\t\t\nverification=${JSON.stringify(domainRoute.verification)}\n${dnsLines}`
    );
    expect(requests.at(-1)?.body).toEqual({ hostname: "www.example.com" });
    await expectCommand(["apps", "domains", "list", "app_ops", "--account", "acct_ops"], api.baseUrl, dnsLines);
    await expectCommand(["apps", "domains", "verify", "app_ops", "www.example.com", "--account", "acct_ops"], api.baseUrl, "active");
    // The API answers a removed domain with its records as well; the CLI asks for none of them.
    const removed = await runCli(["apps", "domains", "remove", "app_ops", "www.example.com", "--account", "acct_ops"], api.baseUrl);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("route_domain\tcustom_domain\tdeleted\twww.example.com\t\tRoute deleted.\n");
    expect(removed.stdout).not.toMatch(/^dns_/mu);
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

    const list = await runCli(["apps", "list"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("app_saved");
    expect(requests.find((request) => request.url === "/v0/apps")?.authorization).toBe("Bearer created_api_key");

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
            docs_url: "https://docs.userland.fun/reference/limits/",
            self_serve_upgrade: true,
            upgrade_url: "https://console.userland.fun/billing",
            violations: [
              {
                kind: "manifest_feature",
                feature_key: "auth.public_signup",
                manifest_path: "/resources/auth/public_signup",
                value: true,
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
    expect(result.stderr).toContain("violation=/resources/auth/public_signup feature=auth.public_signup value=true requires=business");
    expect(result.stderr).toContain("violation=/resources/jobs/*/schedule limit=jobs.schedule.allowed value=1 allowed=daily requires=business");
    expect(result.stderr).toContain("self_serve_upgrade=true");
    expect(result.stderr).toContain("upgrade_url=https://console.userland.fun/billing");
    expect(result.stderr).toContain("Docs: https://docs.userland.fun/reference/limits/");
  });

  test("prints the console link that fixes a payment or domain refusal", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/apps/app_ops/slugs": {
        __status: 402,
        error: {
          code: "billing_restricted",
          message: "This account is restricted by billing state.",
          details: {
            account_id: "acct_ops",
            billing_access_state: "past_due_restricted",
            reasons: ["billing:past_due_restricted"],
            billing_url: "https://console.userland.fun/billing?account=acct_ops"
          }
        }
      },
      "POST /v0/apps/app_ops/domains/www.example.com/verify": {
        __status: 409,
        error: {
          code: "domain_pending_verification",
          message: "Domain DNS verification is still pending.",
          details: {
            route_id: "route_domain",
            hostname: "www.example.com",
            status: "pending_certificate",
            verification: { status: "pending" },
            dns_instructions: {
              traffic: { type: "CNAME", name: "www.example.com", value: "customers.userland.fun" },
              ownership_txt: { type: "TXT", name: "_userland.www.example.com", value: "userland-route=route_domain" },
              ownership_status: "verified",
              provider_validation_records: { cname: "_acme.www.example.com", cname_target: "dcv.example.net" },
              verification_errors: [],
              last_refreshed_at: "2026-05-05T00:00:00.000Z"
            },
            domain_url: "https://console.userland.fun/apps/app_ops/settings?domain=www.example.com&account=acct_ops"
          }
        }
      }
    });

    const billing = await runCli(["apps", "slugs", "add", "app_ops", "demo", "--account", "acct_ops"], api.baseUrl);
    expect(billing.code).toBe(1);
    expect(billing.stderr).toContain(
      "API 402: This account is restricted by billing state.\nerror=billing_restricted\nbilling_url=https://console.userland.fun/billing?account=acct_ops\n"
    );

    const pending = await runCli(["apps", "domains", "verify", "app_ops", "www.example.com", "--account", "acct_ops"], api.baseUrl);
    expect(pending.code).toBe(1);
    expect(pending.stdout).toBe("");
    expect(pending.stderr).toContain(
      "API 409: Domain DNS verification is still pending.\n" +
        "error=domain_pending_verification\n" +
        "domain_url=https://console.userland.fun/apps/app_ops/settings?domain=www.example.com&account=acct_ops\n" +
        "hostname=www.example.com\n" +
        "status=pending_certificate\n" +
        "dns_record=traffic type=CNAME name=www.example.com value=customers.userland.fun\n" +
        "dns_record=ownership_txt type=TXT name=_userland.www.example.com value=userland-route=route_domain\n" +
        "dns_record=provider_validation type=CNAME name=_acme.www.example.com value=dcv.example.net\n" +
        "dns_ownership_status=verified\n" +
        "dns_last_refreshed_at=2026-05-05T00:00:00.000Z\n"
    );
  });

  test("prints why a rollback's server did not start, says the rollback did not happen, and to run the command again", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/apps/app_ops/rollback": [
        {
          __status: 502,
          error: {
            code: "platform_deploy_failed",
            message: "User Worker activation probe failed.",
            details: { status: 503, reason: "runtime_unavailable", attempts: 10 }
          }
        },
        {
          status: "rolled_back",
          app_id: "app_ops",
          release_id: "rel_old",
          origin: "https://app_ops.apps.userland.fun/",
          previous_release_id: "rel_new"
        }
      ]
    });

    const failed = await runCli(["apps", "rollback", "app_ops", "rel_old"], api.baseUrl);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toBe(
      [
        "API 502: User Worker activation probe failed.",
        "error=platform_deploy_failed",
        "reason=runtime_unavailable",
        "status=503",
        "attempts=10",
        "The rollback did not happen: your app is still on its current release. Run the same command again in a minute.",
        "Docs: https://docs.userland.fun/guides/rollback",
        ""
      ].join("\n")
    );

    // Running the same command again is what the error asks for.
    const retried = await runCli(["apps", "rollback", "app_ops", "rel_old"], api.baseUrl);
    expect(retried.code).toBe(0);
    expect(retried.stdout).toContain("Rolled back https://app_ops.apps.userland.fun/\napp_id=app_ops\nrelease_id=rel_old\nprevious_release_id=rel_new");
    expect(retried.stderr).toBe("");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /v0/apps/app_ops/rollback", "POST /v0/apps/app_ops/rollback"]);
    expect(requests.map((request) => request.body)).toEqual([{ release_id: "rel_old" }, { release_id: "rel_old" }]);
  });

  test("does not say to run a rollback again when the host refused the upload or it could not be checked", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/apps/app_x/rollback": [
        {
          __status: 502,
          error: {
            code: "platform_deploy_failed",
            message: "User Worker upload failed.",
            details: { status: 400, errors: [{ code: 10027, message: "Your Worker exceeded the size limit of 10 MiB." }] }
          }
        },
        { __status: 502, error: { code: "platform_deploy_failed", message: "User Worker upload could not be probed." } }
      ]
    });
    const support = 'Running the same command again will not fix this. Send this output to support: userland support open --subject "Rollback failed" --app app_x';

    const refused = await runCli(["apps", "rollback", "app_x", "rel_old"], api.baseUrl);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(
      [
        "API 502: User Worker upload failed.",
        "error=platform_deploy_failed",
        "status=400",
        'upload_error="Your Worker exceeded the size limit of 10 MiB." code=10027',
        `The rollback did not happen: your app is still on its current release. ${support}`,
        "Docs: https://docs.userland.fun/guides/rollback",
        ""
      ].join("\n")
    );
    expect(refused.stderr).not.toContain("in a minute");

    const unchecked = await runCli(["apps", "rollback", "app_x", "rel_old"], api.baseUrl);
    expect(unchecked.code).toBe(1);
    expect(unchecked.stderr).toBe(
      [
        "API 502: User Worker upload could not be probed.",
        "error=platform_deploy_failed",
        `The rollback did not happen: your app is still on its current release. ${support}`,
        "Docs: https://docs.userland.fun/guides/rollback",
        ""
      ].join("\n")
    );
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /v0/apps/app_x/rollback", "POST /v0/apps/app_x/rollback"]);
  });

  test("prints the details a failed server update has, and says to run a rollback again only when that can work", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "PUT /v0/apps/app_ops": {
        __status: 502,
        error: {
          code: "platform_deploy_failed",
          message: "User Worker activation probe failed.",
          details: { status: null, reason: "fetch_failed", attempts: 10 }
        }
      },
      "POST /v0/apps/app_ops/rollback": [
        {
          __status: 502,
          error: {
            code: "platform_deploy_failed",
            message: "User Worker upload failed.",
            details: { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
          }
        },
        {
          __status: 502,
          error: { code: "platform_deploy_failed", message: "User Worker upload failed.", details: { status: 429, errors: [] } }
        },
        {
          __status: 502,
          error: {
            code: "platform_deploy_failed",
            message: "User Worker activation probe failed.",
            details: { status: 503, reason: "not ok\nstatus=200", attempts: { count: 10 } }
          }
        }
      ]
    });
    const retry = "The rollback did not happen: your app is still on its current release. Run the same command again in a minute.";

    // A publish gets the details but no advice: running a first publish again would create a second app.
    const publish = await runCli(["apps", "publish", "examples/hello-static", "--app", "app_ops", "--skip-local-validation"], api.baseUrl);
    expect(publish.code).toBe(1);
    expect(publish.stdout).toBe("local_validation=skipped\n");
    expect(publish.stderr).toContain(["API 502: User Worker activation probe failed.", "error=platform_deploy_failed", "reason=fetch_failed", "attempts=10", "Docs: "].join("\n"));
    expect(publish.stderr).not.toContain("status=");
    expect(publish.stderr).not.toContain("rollback did not happen");
    expect(publish.stderr).not.toContain("Run the same command again");

    const upload = await runCli(["apps", "rollback", "app_ops", "rel_old"], api.baseUrl);
    expect(upload.code).toBe(1);
    expect(upload.stderr).toContain(
      ["API 502: User Worker upload failed.", "error=platform_deploy_failed", "status=500", 'upload_error="Internal error" code=10000', retry, "Docs: "].join("\n")
    );

    const busy = await runCli(["apps", "rollback", "app_ops", "rel_old"], api.baseUrl);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain(["API 502: User Worker upload failed.", "error=platform_deploy_failed", "status=429", retry, "Docs: "].join("\n"));

    // A reason with a line break stays on one quoted line, and a non-number attempts is left out.
    const odd = await runCli(["apps", "rollback", "app_ops", "rel_old"], api.baseUrl);
    expect(odd.code).toBe(1);
    expect(odd.stderr).toContain(["error=platform_deploy_failed", 'reason="not ok\\nstatus=200"', "status=503", retry, "Docs: "].join("\n"));
    expect(odd.stderr).not.toContain("attempts=");
  });

  test("keeps the output of other API errors unchanged when their details have reason or status", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "POST /v0/apps/app_ops/rollback": {
        __status: 409,
        error: {
          code: "incompatible_release",
          message: "Target release is not compatible with current app state.",
          details: { reasons: ["collection.notes is missing."], reason: "schema", status: 409, attempts: 1 }
        }
      }
    });

    const result = await runCli(["apps", "rollback", "app_ops", "rel_old"], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "API 409: Target release is not compatible with current app state.",
        "error=incompatible_release",
        "Docs: https://docs.userland.fun/guides/troubleshooting",
        ""
      ].join("\n")
    );
  });

  test("validates an app directory offline", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {});

    const result = await runCli(["validate", "examples/hello-static"], api.baseUrl, { apiKey: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Validation passed.\nmanifest=examples/hello-static/manifest.userland.json\nplan=none\nrequired_plan=free\n");
    expect(result.stderr).toBe("");
    expect(requests).toHaveLength(0);
  });

  test("reports plan-gated features without --plan and does not fail on them", async () => {
    const result = await runCli(["validate", "examples/tiny-store"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Validation passed.");
    expect(result.stdout).toContain("required_plan=business");
    expect(result.stdout).toContain("Plan-gated features");
    expect(result.stdout).toContain(["manifest_path=resources.jobs.expire-abandoned-orders.schedule", "limit=jobs.schedule.allowed", "value=hourly", "requires=business"].join("\n"));
    expect(result.stdout).toContain(["manifest_path=resources.auth.public_signup", "feature=auth.public_signup", "value=true", "requires=business"].join("\n"));
  });

  test("fails --plan validation with manifest paths, keys, values, allowed values, and required plans", async () => {
    const result = await runCli(["validate", "examples/tiny-store", "--plan", "free"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(2);
    expect(result.stdout.startsWith("Validation failed.\n")).toBe(true);
    expect(result.stdout).toContain("plan=free\nplan_source=flag\nrequired_plan=business");
    expect(result.stdout).toContain(["manifest_path=resources.jobs.expire-abandoned-orders.schedule", "limit=jobs.schedule.allowed", "value=hourly", "allowed=none", "requires=business"].join("\n"));
    expect(result.stdout).toContain(["manifest_path=resources.auth.public_signup", "feature=auth.public_signup", "value=true", "allowed=false", "requires=business"].join("\n"));
    expect(result.stdout).toContain(["manifest_path=resources.secrets.required", "limit=secrets.required.max", "value=2", "allowed=1", "requires=starter"].join("\n"));
    expect(result.stdout).toContain("userland validate examples/tiny-store --plan business");

    const starter = await runCli(["validate", "examples/webhook-automation", "--plan", "starter"], "http://127.0.0.1:1", { apiKey: null });
    expect(starter.code).toBe(0);
    expect(starter.stdout).toContain("Validation passed.");

    const alias = await runCli(["validate", "examples/tiny-store", "--plan", "team"], "http://127.0.0.1:1", { apiKey: null });
    expect(alias.code).toBe(0);
    expect(alias.stdout).toContain("plan=business");

    const businessPlus = await runCli(["validate", "examples/tiny-store", "--plan", "business_plus"], "http://127.0.0.1:1", { apiKey: null });
    expect(businessPlus.code).toBe(0);
  });

  test("prints stable validation JSON", async () => {
    const result = await runCli(["validate", "examples/tiny-store", "--plan", "starter", "--json"], "http://127.0.0.1:1", { apiKey: null });

    expect(result.code).toBe(2);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["ok", "plan", "plan_source", "required_plan_key", "violations", "plan_gated", "errors", "warnings", "manifest_file", "release", "embed_origins"]);
    expect(output).toMatchObject({ ok: false, plan: "starter", plan_source: "flag", required_plan_key: "business", errors: [], manifest_file: "manifest.userland.json" });
    expect(output.violations).toEqual([
      {
        kind: "manifest_feature",
        manifest_path: "resources.auth.public_signup",
        feature_key: "auth.public_signup",
        value: true,
        allowed: false,
        plan_key: "starter",
        required_plan_key: "business",
        message: "Public app-user signup: requires Business."
      },
      {
        kind: "manifest_limit",
        manifest_path: "resources.jobs.expire-abandoned-orders.schedule",
        limit_key: "jobs.schedule.allowed",
        value: "hourly",
        allowed: ["daily"],
        plan_key: "starter",
        required_plan_key: "business",
        message: "Job schedule: hourly is not allowed on Starter (allowed: daily). Requires Business."
      }
    ]);

    const passing = await runCli(["validate", "examples/hello-static", "--json"], "http://127.0.0.1:1", { apiKey: null });
    expect(passing.code).toBe(0);
    expect(JSON.parse(passing.stdout)).toMatchObject({ ok: true, plan: null, plan_source: null, required_plan_key: "free", violations: [], plan_gated: [], errors: [] });
  });

  test("fails validation on manifest shape and unsafe paths", async () => {
    const dir = await temporaryAppDir({
      app: { name: "Broken", visibility: "secret" },
      runtime: { static_root: "../public" },
      resources: { jobs: { nightly: { trigger: "schedule", schedule: "weekly" } } }
    });

    const human = await runCli(["validate", dir], "http://127.0.0.1:1", { apiKey: null });
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("Validation failed.");
    expect(human.stdout).toContain("error=schema\nmanifest_path=app.visibility\nmessage=must be one of: public");
    expect(human.stdout).toContain("manifest_path=resources.jobs.nightly.schedule\nmessage=must be one of: every_15_minutes, hourly, daily");
    expect(human.stdout).toContain("manifest_path=runtime.static_root");

    const json = await runCli(["validate", dir, "--json", "--plan", "free"], "http://127.0.0.1:1", { apiKey: null });
    expect(json.code).toBe(1);
    const output = JSON.parse(json.stdout) as { ok: boolean; errors: Array<{ code: string; manifest_path: string }> };
    expect(output.ok).toBe(false);
    expect(output.errors.map((error) => error.manifest_path)).toEqual(["app.visibility", "runtime.static_root", "resources.jobs.nightly.schedule"]);
  });

  test("shows the sites allowed to embed the app, and the API's errors for bad ones", async () => {
    const dir = await temporaryAppDir({
      app: { name: "Embed" },
      runtime: { static_root: "public", fallback: "index.html", embed_origins: ["https://WWW.Example.com", "https://*.example.com", "https://www.example.com"] }
    });
    const human = await runCli(["validate", dir], "http://127.0.0.1:1", { apiKey: null });
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/\nrelease_bytes=\d+\nembed_origins=https:\/\/www\.example\.com,https:\/\/\*\.example\.com\n/u);
    const json = JSON.parse((await runCli(["validate", dir, "--json"], "http://127.0.0.1:1", { apiKey: null })).stdout);
    expect(json).toMatchObject({ ok: true, errors: [], embed_origins: ["https://www.example.com", "https://*.example.com"] });

    // Without a list, the human output says nothing and the JSON has an empty list.
    const plain = await temporaryAppDir({ app: { name: "Plain" }, runtime: { static_root: "public" } });
    expect((await runCli(["validate", plain], "http://127.0.0.1:1", { apiKey: null })).stdout).not.toContain("embed_origins");
    expect(JSON.parse((await runCli(["validate", plain, "--json"], "http://127.0.0.1:1", { apiKey: null })).stdout).embed_origins).toEqual([]);

    const bad = await temporaryAppDir({
      app: { name: "Embed" },
      runtime: { static_root: "public", embed_origins: ["https://www.example.com/", "https://shop.apps.userland.fun", "https://127.0.0.1"] }
    });
    const badHuman = await runCli(["validate", bad], "http://127.0.0.1:1", { apiKey: null });
    expect(badHuman.code).toBe(1);
    expect(badHuman.stdout).toContain(
      [
        "error=invalid_runtime_manifest",
        "manifest_path=runtime.embed_origins[0]",
        'message=runtime.embed_origins[0] ("https://www.example.com/") must be an origin without a path, query or fragment (no trailing slash), for example https://example.com or https://*.example.com.',
        "",
        "error=invalid_runtime_manifest",
        "manifest_path=runtime.embed_origins[1]",
        'message=runtime.embed_origins[1] ("https://shop.apps.userland.fun") cannot be a Userland address: other apps and Userland sites can never show this app in a frame.',
        "",
        "error=invalid_runtime_manifest",
        "manifest_path=runtime.embed_origins[2]",
        'message=runtime.embed_origins[2] ("https://127.0.0.1") must use a domain name, not an IP address.'
      ].join("\n")
    );
    expect(badHuman.stdout).not.toContain("\nembed_origins=");
    const badJson = JSON.parse((await runCli(["validate", bad, "--json"], "http://127.0.0.1:1", { apiKey: null })).stdout);
    expect(badJson).toMatchObject({ ok: false, embed_origins: null, required_plan_key: null });
    expect(badJson.errors.map((error: { manifest_path: string }) => error.manifest_path)).toEqual(["runtime.embed_origins[0]", "runtime.embed_origins[1]", "runtime.embed_origins[2]"]);
  });

  test("publishes runtime.embed_origins as written, and blocks a bad one before uploading", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/limits": limitsResponse("acct_owner", "free"),
      "PUT /v0/apps": {
        status: "published",
        app_id: "app_embed",
        release_id: "rel_embed",
        origin: "https://app_embed.apps.userland.fun/",
        previous_release_id: null,
        activation: { status: "live", reasons: [], missing_secrets: [], previous_release_id: null }
      }
    });

    const origins = ["https://WWW.Example.com", "https://*.example.com"];
    const good = await temporaryAppDir({ app: { name: "Embed" }, runtime: { static_root: "public", embed_origins: origins } });
    const published = await runCli(["apps", "publish", good], api.baseUrl);
    expect(published.code).toBe(0);
    expect(published.stdout).toContain("local_validation=passed\nlocal_validation_plan=free");
    const body = requests.filter((request) => request.method === "PUT").at(-1)?.body as { runtime?: Record<string, unknown> };
    // The API checks the list again and stores it in lowercase.
    expect(body.runtime).toEqual({ static_root: "public", embed_origins: origins });

    const bad = await temporaryAppDir({ app: { name: "Embed" }, runtime: { static_root: "public", embed_origins: ["http://www.example.com"] } });
    const blocked = await runCli(["apps", "publish", bad], api.baseUrl);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("Local validation blocked this publish; nothing was uploaded.");
    expect(blocked.stderr).toContain('error=invalid_runtime_manifest\nmanifest_path=runtime.embed_origins[0]\nmessage=runtime.embed_origins[0] ("http://www.example.com") must use https://.');
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("accepts a top-level release message, including with --strict", async () => {
    const dir = await temporaryAppDir({
      app: { name: "Message" },
      runtime: { static_root: "public" },
      message: "Launch copy refresh"
    });

    for (const args of [["validate", dir], ["validate", dir, "--strict"], ["validate", dir, "--strict", "--plan", "free", "--json"]]) {
      const result = await runCli(args, "http://127.0.0.1:1", { apiKey: null });
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.stdout).not.toContain("schema_strict");
      expect(result.stderr).toBe("");
    }
    const json = JSON.parse((await runCli(["validate", dir, "--strict", "--json"], "http://127.0.0.1:1", { apiKey: null })).stdout);
    expect(json).toMatchObject({ ok: true, errors: [], warnings: [] });

    const badMessage = await temporaryAppDir({ app: { name: "Message" }, runtime: { static_root: "public" }, message: 42 });
    // A non-string message is ignored when publishing (the API ignores it too), so it only warns.
    const bad = await runCli(["validate", badMessage, "--json"], "http://127.0.0.1:1", { apiKey: null });
    expect(bad.code).toBe(0);
    expect(JSON.parse(bad.stdout)).toMatchObject({
      ok: true,
      errors: [],
      warnings: [{ code: "schema_strict", manifest_path: "message", message: "must be a string (ignored when publishing)" }]
    });
    const badStrict = await runCli(["validate", badMessage, "--strict", "--json"], "http://127.0.0.1:1", { apiKey: null });
    expect(badStrict.code).toBe(1);
    expect(JSON.parse(badStrict.stdout).errors).toEqual([{ code: "schema_strict", manifest_path: "message", message: "must be a string (ignored when publishing)" }]);
  });

  test("publishes the manifest release message unless --message overrides it", async () => {
    const dir = await temporaryAppDir({
      app: { name: "Message" },
      runtime: { static_root: "public" },
      message: "Launch copy refresh"
    });
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/limits": limitsResponse("acct_owner", "free"),
      "PUT /v0/apps": {
        status: "published",
        app_id: "app_message",
        release_id: "rel_message",
        origin: "https://app_message.apps.userland.fun/",
        previous_release_id: null,
        activation: { status: "live", reasons: [], missing_secrets: [], previous_release_id: null }
      }
    });

    const fromManifest = await runCli(["apps", "publish", dir], api.baseUrl);
    expect(fromManifest.code).toBe(0);
    expect(fromManifest.stdout).toContain("local_validation=passed");
    expect(fromManifest.stdout).not.toContain("schema_strict");
    const manifestPublish = requests.filter((request) => request.method === "PUT").at(-1);
    expect((manifestPublish?.body as { message?: string }).message).toBe("Launch copy refresh");

    const overridden = await runCli(["apps", "publish", dir, "--message", "Flag wins"], api.baseUrl);
    expect(overridden.code).toBe(0);
    const flagPublish = requests.filter((request) => request.method === "PUT").at(-1);
    expect((flagPublish?.body as { message?: string }).message).toBe("Flag wins");
  });

  test("README validate samples are the real output for webhook-automation", async () => {
    const readme = await fs.readFile(path.join(repoRoot, "cli", "README.md"), "utf8");
    const human = await runCli(["validate", "examples/webhook-automation", "--plan", "free"], "http://127.0.0.1:1", { apiKey: null });
    expect(human.code).toBe(2);
    expect(readme).toContain("```text\n" + human.stdout + "```");
    const json = await runCli(["validate", "examples/webhook-automation", "--plan", "free", "--json"], "http://127.0.0.1:1", { apiKey: null });
    expect(json.code).toBe(2);
    expect(readme).toContain("```json\n" + json.stdout + "```");
  });

  test("points values beyond Business Plus to support instead of a plan", async () => {
    const dir = await temporaryAppDir({
      app: { name: "Verify" },
      runtime: { static_root: "public" },
      resources: { auth: { mode: "app_users", email_verification: true } }
    });

    const report = await runCli(["validate", dir], "http://127.0.0.1:1", { apiKey: null });
    expect(report.code).toBe(0);
    expect(report.stdout).toContain("required_plan=internal");
    expect(report.stdout).toContain("message=App-user email verification: is not available on self-serve plans; contact support.");
    expect(report.stdout).toContain("This app uses features or limits that are not available on self-serve plans; contact support.\nDocs: https://docs.userland.fun/reference/limits/");

    const blocked = await runCli(["validate", dir, "--plan", "business_plus"], "http://127.0.0.1:1", { apiKey: null });
    expect(blocked.code).toBe(2);
    expect(blocked.stdout).toContain("requires=internal");
    expect(blocked.stdout).toContain("- Change or remove the manifest values above. Some of them are not available on self-serve plans; contact support if you need them.");
    expect(blocked.stdout).toContain("Docs: https://docs.userland.fun/reference/limits/");
    for (const output of [report.stdout, blocked.stdout]) {
      expect(output).not.toMatch(/--plan internal|Internal|Agency|agency/u);
    }
  });

  test("rejects unknown plans and missing directories", async () => {
    const plan = await runCli(["validate", "examples/hello-static", "--plan", "gold"], "http://127.0.0.1:1", { apiKey: null });
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain("Unknown plan: gold. Use one of: free, starter, business, business_plus.");

    // Agency is off sale and the internal plan is operator-assigned: both are unknown plans here.
    for (const retired of ["agency", "internal"]) {
      const rejected = await runCli(["validate", "examples/hello-static", "--plan", retired], "http://127.0.0.1:1", { apiKey: null });
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain(`Unknown plan: ${retired}. Use one of: free, starter, business, business_plus.`);
      expect(rejected.stderr).toContain("Docs: https://docs.userland.fun/reference/limits/");
      expect(rejected.stdout).toBe("");
    }
    const publishAgency = await runCli(["apps", "publish", "examples/hello-static", "--plan", "agency"], "http://127.0.0.1:1");
    expect(publishAgency.code).toBe(1);
    expect(publishAgency.stderr).toContain("Unknown plan: agency. Use one of: free, starter, business, business_plus.");
    for (const retired of ["agency", "internal"]) {
      const downgrade = await runCli(["accounts", "downgrade", "preview", "--to", retired, "--account", "acct_ops"], "http://127.0.0.1:1");
      expect(downgrade.code).toBe(1);
      expect(downgrade.stderr).toContain(`Unknown plan: ${retired}. Use one of: free, starter, business, business_plus.`);
      expect(downgrade.stdout).toBe("");
    }

    const missing = await runCli(["validate", "examples/does-not-exist", "--json"], "http://127.0.0.1:1", { apiKey: null });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).errors[0]).toMatchObject({ code: "directory_not_found" });

    const noDir = await runCli(["validate"], "http://127.0.0.1:1", { apiKey: null });
    expect(noDir.code).toBe(1);
    expect(noDir.stderr).toContain("Usage:");
  });

  test("blocks publish before upload when the account plan does not allow the manifest", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/limits": limitsResponse("acct_owner", "free")
    });

    const result = await runCli(["apps", "publish", "examples/tiny-store"], api.baseUrl);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Local validation blocked this publish; nothing was uploaded.");
    expect(result.stderr).toContain("plan=free\nplan_source=account\nrequired_plan=business");
    expect(result.stderr).toContain(["manifest_path=resources.auth.public_signup", "feature=auth.public_signup", "value=true", "allowed=false", "requires=business"].join("\n"));
    expect(result.stderr).toContain("userland apps publish examples/tiny-store --skip-local-validation");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/accounts", "GET /v0/accounts/acct_owner/limits"]);
    expect(requests[1].accountId).toBe("acct_owner");
  });

  test("uses the account's effective entitlements, including overrides", async () => {
    const requests: RequestRecord[] = [];
    const comped = limitsResponse("acct_comped", "starter");
    comped.features = { ...comped.features, "auth.public_signup": true };
    comped.manifest_limits = { ...comped.manifest_limits, "jobs.schedule.allowed": ["daily", "hourly"] };
    const api = await startMockApi(requests, {
      "GET /v0/accounts/acct_comped/limits": comped,
      "PUT /v0/apps": publishResponse("app_store")
    });

    const result = await runCli(["apps", "publish", "examples/tiny-store", "--account", "acct_comped"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local_validation=passed\nlocal_validation_plan=starter\nlocal_validation_plan_source=account");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/accounts/acct_comped/limits", "PUT /v0/apps"]);
    expect(requests.every((request) => request.accountId === "acct_comped")).toBe(true);
  });

  test("checks updates against the plan of the account that owns the app", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_client": { app_id: "app_client", account_id: "acct_client", name: "Client", origin: "https://app_client.apps.userland.fun/" },
      "GET /v0/accounts/acct_client/limits": limitsResponse("acct_client", "business"),
      "PUT /v0/apps/app_client": publishResponse("app_client")
    });

    const result = await runCli(["apps", "publish", "examples/tiny-store", "--app", "app_client"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local_validation_plan=business");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /v0/apps/app_client",
      "GET /v0/accounts/acct_client/limits",
      "PUT /v0/apps/app_client"
    ]);
  });

  test("blocks publish with --plan and manifest errors without any network request", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {});

    const plan = await runCli(["apps", "publish", "examples/webhook-automation", "--plan", "free"], api.baseUrl);
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain("feature=webhooks.enabled");
    expect(plan.stderr).toContain("plan=free\nplan_source=flag");

    const dir = await temporaryAppDir({ app: { name: "Broken" }, runtime: { static_root: "public", server_entry: "server/missing.js" } });
    const broken = await runCli(["publish", dir], api.baseUrl);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("error=missing_server_entry\nmanifest_path=runtime.server_entry");

    expect(requests).toHaveLength(0);
  });

  test("skips local validation only when asked", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "PUT /v0/apps": publishResponse("app_store")
    });

    const result = await runCli(["apps", "publish", "examples/tiny-store", "--skip-local-validation"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local_validation=skipped");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["PUT /v0/apps"]);

    const conflicting = await runCli(["apps", "publish", "examples/tiny-store", "--skip-local-validation", "--plan", "free"], api.baseUrl);
    expect(conflicting.code).toBe(1);
    expect(conflicting.stderr).toContain("--plan cannot be combined with --skip-local-validation.");
  });

  test("continues to the API when the account plan cannot be read", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": { __status: 503, error: { code: "unavailable", message: "Try again." } },
      "PUT /v0/apps": publishResponse("app_store")
    });

    const result = await runCli(["apps", "publish", "examples/tiny-store"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("warning=plan_lookup_failed API 503: Try again.");
    expect(result.stderr).toContain("warning=plan_check_skipped This app needs the Business plan or higher; the API will check your account plan.");
    expect(result.stdout).toContain("local_validation=passed_without_plan");
    expect(requests.at(-1)?.url).toBe("/v0/apps");
  });

  test("publishes manifests the API accepts even when the published schema is stricter", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/limits": limitsResponse("acct_owner", "free"),
      "PUT /v0/apps": publishResponse("app_schema")
    });
    const dir = await temporaryAppDir({
      $schema: "https://docs.userland.fun/schemas/resource-manifest-v0.schema.json",
      app: { name: "Schema hint", description: "Ignored by the API" },
      runtime: { static_root: "public" },
      resources: null
    });

    const result = await runCli(["apps", "publish", dir], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local_validation=passed\nlocal_validation_plan=free");
    expect(result.stderr).toContain("warning=schema_strict manifest_path=app.description is not an allowed key");
    expect(result.stderr).toContain("warning=schema_strict manifest_path=resources must be an object");
    expect(result.stderr).not.toContain("$schema");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/accounts", "GET /v0/accounts/acct_owner/limits", "PUT /v0/apps"]);
    expect(requests[2].body).toMatchObject({ app: { name: "Schema hint" }, resources: {} });

    const validate = await runCli(["validate", dir], api.baseUrl, { apiKey: null });
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("Validation passed.");
    expect(validate.stdout).toContain("warning=schema_strict manifest_path=app.description");

    const strict = await runCli(["validate", dir, "--strict", "--json"], api.baseUrl, { apiKey: null });
    expect(strict.code).toBe(1);
    const output = JSON.parse(strict.stdout) as { ok: boolean; errors: Array<{ code: string; manifest_path: string }> };
    expect(output.ok).toBe(false);
    expect(output.errors.map((error) => [error.code, error.manifest_path])).toEqual([
      ["schema_strict", "app.description"],
      ["schema_strict", "resources"]
    ]);
  });

  test("fails validation and blocks publish for signed webhooks without a secret", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {});
    const dir = await temporaryAppDir({
      app: { name: "Hooks" },
      runtime: { static_root: "public" },
      resources: { jobs: { sync: {} }, webhooks: { gh: { provider: "github", deliver_to: "job:sync" } } }
    });

    const validate = await runCli(["validate", dir, "--plan", "business"], api.baseUrl, { apiKey: null });
    expect(validate.code).toBe(1);
    expect(validate.stdout).toContain("error=invalid_resource_manifest\nmanifest_path=resources.webhooks.gh.secret\nmessage=is required when provider is github");

    const publish = await runCli(["apps", "publish", dir], api.baseUrl);
    expect(publish.code).toBe(1);
    expect(publish.stderr).toContain("manifest_path=resources.webhooks.gh.secret");
    expect(requests).toHaveLength(0);
  });

  test("accepts Stripe as a sender with a signing key, on Starter and up", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/limits": limitsResponse("acct_owner", "starter"),
      "PUT /v0/apps": publishResponse("app_payments")
    });
    const manifest = {
      app: { name: "Payments" },
      runtime: { static_root: "public", server_entry: "server/index.js" },
      resources: {
        secrets: { required: ["STRIPE_WEBHOOK_SECRET"] },
        jobs: { handle: {} },
        webhooks: { payments: { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", deliver_to: "job", job: "handle" } }
      }
    };
    const files = { "public/index.html": "<h1>hi</h1>", "server/index.js": "export default { fetch() { return new Response('ok'); } };" };
    const dir = await temporaryAppDir(manifest, files);

    const validate = await runCli(["validate", dir, "--json"], api.baseUrl, { apiKey: null });
    expect(validate.code).toBe(0);
    const report = JSON.parse(validate.stdout) as { ok: boolean; errors: unknown[]; warnings: unknown[]; required_plan_key: string; plan_gated: Array<{ feature_key?: string; required_plan_key: string }> };
    expect(report).toMatchObject({ ok: true, errors: [], warnings: [], required_plan_key: "starter" });
    expect(report.plan_gated).toContainEqual(expect.objectContaining({ feature_key: "webhooks.provider.stripe", required_plan_key: "starter" }));

    const free = await runCli(["validate", dir, "--plan", "free"], api.baseUrl, { apiKey: null });
    expect(free.code).toBe(2);
    expect(free.stdout).toContain(
      ["manifest_path=resources.webhooks.payments.provider", "feature=webhooks.provider.stripe", "value=stripe", "allowed=false", "requires=starter"].join("\n")
    );
    expect(free.stdout).toContain("message=Stripe webhooks: requires Starter.");
    for (const plan of ["starter", "business", "business_plus"]) {
      const allowed = await runCli(["validate", dir, "--plan", plan], api.baseUrl, { apiKey: null });
      expect(allowed.code, plan).toBe(0);
    }

    // The publish preflight checks the account's own plan, then uploads the manifest as written.
    const publish = await runCli(["apps", "publish", dir], api.baseUrl);
    expect(publish.code).toBe(0);
    expect(publish.stdout).toContain("local_validation=passed\nlocal_validation_plan=starter\nlocal_validation_plan_source=account");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/accounts", "GET /v0/accounts/acct_owner/limits", "PUT /v0/apps"]);
    expect(requests[2].body).toMatchObject({ resources: { webhooks: { payments: { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", deliver_to: "job", job: "handle" } } } });

    // A Stripe webhook needs the name of the secret that holds Stripe's signing secret, like any signed sender.
    const unsigned = await temporaryAppDir({ ...manifest, resources: { ...manifest.resources, webhooks: { payments: { provider: "stripe", deliver_to: "job", job: "handle" } } } }, files);
    const missing = await runCli(["validate", unsigned, "--plan", "business"], api.baseUrl, { apiKey: null });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("error=invalid_resource_manifest\nmanifest_path=resources.webhooks.payments.secret\nmessage=is required when provider is stripe");
    const blocked = await runCli(["apps", "publish", unsigned], api.baseUrl);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("manifest_path=resources.webhooks.payments.secret");
    expect(requests).toHaveLength(3);
  });

  test("blocks a Stripe webhook on an account whose plan doesn't include it", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": accountsResponse(),
      "GET /v0/accounts/acct_owner/limits": limitsResponse("acct_owner", "free")
    });
    const dir = await temporaryAppDir({
      app: { name: "Payments" },
      runtime: { static_root: "public" },
      resources: { secrets: { required: ["STRIPE_WEBHOOK_SECRET"] }, webhooks: { payments: { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", deliver_to: "server" } } }
    });

    const result = await runCli(["apps", "publish", dir], api.baseUrl);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Local validation blocked this publish; nothing was uploaded.");
    expect(result.stderr).toContain(["manifest_path=resources.webhooks.payments.provider", "feature=webhooks.provider.stripe", "value=stripe", "allowed=false", "requires=starter"].join("\n"));
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/accounts", "GET /v0/accounts/acct_owner/limits"]);
  });

  test("explains a skipped plan check for features no public plan includes", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/accounts": { __status: 500, error: { code: "internal", message: "Boom." } },
      "PUT /v0/apps": publishResponse("app_verify")
    });
    const dir = await temporaryAppDir({
      app: { name: "Verify" },
      runtime: { static_root: "public" },
      resources: { auth: { mode: "app_users", email_verification: true } }
    });

    const result = await runCli(["apps", "publish", dir], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("warning=plan_check_skipped This app uses features that are not available on self-serve plans; the API will check your account plan. Contact support if you need them.");
    expect(result.stderr).not.toMatch(/Internal|Agency|internal plan/u);
    expect(result.stdout).toContain("local_validation=passed_without_plan");
  });

  test("prints compact app analytics", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_ops/analytics?range=30d": analyticsResponse(),
      "GET /v0/apps/app_ops/analytics": analyticsResponse()
    });

    const result = await runCli(["apps", "analytics", "app_ops", "--range", "30d", "--account", "acct_ops"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`app_id=app_ops
range=30d
retention_days=30
total_requests=1234
successful_requests=1200
error_requests=34
error_rate=0.0276

status:
2xx  1200
4xx  20
5xx  14

top_paths:
/         500
/pricing  210
/book     180

top_referrers:
(direct)    700
google.com  250

jobs:
succeeded  12
failed     1

recent_errors:
2026-06-03T10:00:00.000Z error runtime.exception TypeError: boom
`);
    expect(requests[0]).toMatchObject({ method: "GET", url: "/v0/apps/app_ops/analytics?range=30d", accountId: "acct_ops", authorization: "Bearer test_api_key" });

    const alias = await runCli(["analytics", "app_ops"], api.baseUrl, { accountId: "acct_env" });
    expect(alias.code).toBe(0);
    expect(alias.stdout).toContain("total_requests=1234");
    expect(requests.at(-1)).toMatchObject({ url: "/v0/apps/app_ops/analytics", accountId: "acct_env" });
  });

  test("prints app analytics JSON unchanged", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_ops/analytics?range=7d": analyticsResponse()
    });

    const result = await runCli(["apps", "analytics", "app_ops", "--range", "7d", "--json"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(analyticsResponse());
  });

  test("explains empty analytics and clamped ranges", async () => {
    const empty = analyticsResponse();
    empty.range.days = 7;
    empty.entitlement.retention_days = 7;
    empty.traffic = { total_requests: 0, successful_requests: 0, error_requests: 0, error_rate: 0, total_response_bytes: 0, status_buckets: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } };
    empty.top_paths = [];
    empty.top_referrers = [];
    empty.jobs = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 };
    empty.recent_errors = [];
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "GET /v0/apps/app_ops/analytics?range=90d": empty });

    const result = await runCli(["apps", "analytics", "app_ops", "--range", "90d"], api.baseUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("range=7d\nretention_days=7\ntotal_requests=0");
    expect(result.stdout).toContain("note=range clamped from 90d to 7d by the plan retention window");
    expect(result.stdout).toContain("No traffic recorded in this range yet. Analytics appear after the app serves eligible app-owned requests");
    expect(result.stdout).not.toContain("top_paths:");
    expect(result.stdout).not.toContain("recent_errors:");
  });

  test("does not tell customers to buy a plan that is not on sale for analytics", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_x/analytics": {
        __status: 402,
        error: {
          code: "entitlement_required",
          message: "app_analytics is not available on self-serve plans; contact support.",
          details: { plan_key: "free", required_plan_key: "internal", self_serve_upgrade: false, support_url: "https://console.userland.fun/support?subject=App+Analytics&account=acct_x" }
        }
      }
    });

    const result = await runCli(["apps", "analytics", "app_x"], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("App Analytics is not available on self-serve plans for this account; contact support.");
    expect(result.stderr).toContain("self_serve_upgrade=false\nsupport_url=https://console.userland.fun/support?subject=App+Analytics&account=acct_x\n");
    expect(result.stderr).not.toContain("Upgrade to");
    expect(result.stderr).not.toContain("upgrade_url=");
  });

  test("shows an upgrade state when analytics is not in the plan", async () => {
    const requests: RequestRecord[] = [];
    const entitlementError = {
      __status: 402,
      error: {
        code: "entitlement_required",
        message: "app_analytics requires Starter.",
        details: {
          plan_key: "free",
          source: "default",
          feature_key: "app_analytics",
          required_plan_key: "starter",
          violations: [{ kind: "feature", feature_key: "app_analytics", required_plan_key: "starter" }],
          self_serve_upgrade: true,
          docs_url: "https://docs.userland.fun/reference/limits/",
          upgrade_url: "https://console.userland.fun/billing/plans?plan=starter&for=app_analytics&account=acct_free"
        }
      }
    };
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_free/analytics": [entitlementError, entitlementError]
    });

    const result = await runCli(["apps", "analytics", "app_free"], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("App Analytics is not included in this account's plan.");
    expect(result.stderr).toContain(
      "error=entitlement_required\nfeature=app_analytics\nplan_key=free\nrequired_plan_key=starter\nself_serve_upgrade=true\n" +
        "upgrade_url=https://console.userland.fun/billing/plans?plan=starter&for=app_analytics&account=acct_free\n"
    );
    expect(result.stderr).toContain("Upgrade to Starter or higher");
    expect(result.stderr).toContain("Docs: https://docs.userland.fun/guides/app-analytics");

    const json = await runCli(["apps", "analytics", "app_free", "--json"], api.baseUrl);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      app_id: "app_free",
      entitlement: { enabled: false, plan_key: "free", required_plan_key: "starter" },
      error: entitlementError.error,
      docs: "https://docs.userland.fun/guides/app-analytics"
    });
  });

  test("keeps access and not-found errors and rejects invalid ranges locally", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_hidden/analytics": { __status: 404, error: { code: "not_found", message: "App not found." } },
      "GET /v0/apps/app_viewer/analytics": { __status: 403, error: { code: "forbidden", message: "Your account role cannot perform this operation." } }
    });

    const hidden = await runCli(["apps", "analytics", "app_hidden"], api.baseUrl);
    expect(hidden.code).toBe(1);
    expect(hidden.stderr).toContain("API 404: App not found.\nerror=not_found");

    const forbidden = await runCli(["apps", "analytics", "app_viewer"], api.baseUrl);
    expect(forbidden.code).toBe(1);
    expect(forbidden.stderr).toContain("API 403: Your account role cannot perform this operation.");

    const requestCount = requests.length;
    const invalid = await runCli(["apps", "analytics", "app_ops", "--range", "14d"], api.baseUrl);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Invalid --range value: 14d. Use 7d, 30d, or 90d.");
    expect(invalid.stderr).toContain("Usage: userland apps analytics <app-id> [--range 7d|30d|90d] [--account <account-id>] [--json]");

    const missing = await runCli(["apps", "analytics"], api.baseUrl);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Usage: userland apps analytics <app-id>");
    expect(requests).toHaveLength(requestCount);
  });
  test("publishing a folder leaves out dotfiles such as .env, .npmrc, and .git, with a warning", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "PUT /v0/apps": publishResponse("app_dots") });
    const dir = await temporaryAppDir({ app: { name: "Dots" }, runtime: { static_root: "public", fallback: "index.html" } }, {
      "public/index.html": "<h1>hi</h1>",
      "public/.env.local": "SECRET=1",
      "public/.well-known/security.txt": "Contact: mailto:security@userland.fun",
      ".env": "STRIPE_SECRET_KEY=sk_live_abc",
      ".npmrc": "//registry.npmjs.org/:_authToken=npm_SECRET",
      ".git/config": '[remote "origin"] url = https://user:ghp_TOKEN@github.com/o/r'
    });

    for (const extra of [["--plan", "free"], ["--skip-local-validation"]]) {
      const result = await runCli(["apps", "publish", dir, ...extra], api.baseUrl);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("warning=dotfiles_skipped 4 dotfiles and dot-folders are not uploaded (.env, .git/, .npmrc, public/.env.local)");
      const body = requests.at(-1)?.body as { files: Array<{ path: string; content_base64: string }> };
      expect(body.files.map((file) => file.path)).toEqual(["public/.well-known/security.txt", "public/index.html"]);
      expect(JSON.stringify(body)).not.toContain(Buffer.from("sk_live_abc").toString("base64").slice(0, 8));
    }
  });

  test("refuses to publish a folder that holds a private key", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "PUT /v0/apps": publishResponse("app_keys") });
    const dir = await temporaryAppDir({ app: { name: "Keys" }, runtime: { static_root: "public" } }, {
      "public/index.html": "<h1>hi</h1>",
      "certs/localhost-key.pem": "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n"
    });

    const validated = await runCli(["apps", "publish", dir, "--plan", "free"], api.baseUrl);
    expect(validated.code).toBe(1);
    expect(validated.stderr).toContain("error=private_key\nfile=certs/localhost-key.pem\nmessage=looks like a private key");
    expect(validated.stderr).not.toContain("--skip-local-validation");

    const skipped = await runCli(["apps", "publish", dir, "--skip-local-validation"], api.baseUrl);
    expect(skipped.code).toBe(1);
    expect(skipped.stderr).toContain("Not publishing: certs/localhost-key.pem looks like a private key");
    expect(requests).toHaveLength(0);
  });

  test("never uploads symlinked files or paths outside the app folder, even with --skip-local-validation", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "PUT /v0/apps": publishResponse("app_links") });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "userland-outside-"));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, "credentials.json"), JSON.stringify({ api_key: "ul_live_VICTIMKEY" }));

    const dir = await temporaryAppDir({
      app: { name: "Links" },
      runtime: { static_root: "public" },
      files: [{ path: "public/index.html" }, { path: "public/robots.txt" }]
    });
    await fs.symlink(path.join(outside, "credentials.json"), path.join(dir, "public", "robots.txt"));

    const validated = await runCli(["apps", "publish", dir, "--plan", "free"], api.baseUrl);
    expect(validated.code).toBe(1);
    expect(validated.stderr).toContain("error=symlink\nmanifest_path=files[1].path\nfile=public/robots.txt\nmessage=is a symlink.");
    expect(validated.stderr).not.toContain("--skip-local-validation");

    const skipped = await runCli(["apps", "publish", dir, "--skip-local-validation"], api.baseUrl);
    expect(skipped.code).toBe(1);
    expect(skipped.stderr).toContain("Not publishing: public/robots.txt is a symlink.");

    await fs.writeFile(path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`), "outside");
    const parent = await temporaryAppDir({ app: { name: "Parent" }, runtime: { static_root: "public" }, files: [{ path: "public/index.html" }, { path: `../${path.basename(dir)}-outside.txt` }] });
    const parentResult = await runCli(["apps", "publish", parent, "--skip-local-validation"], api.baseUrl);
    expect(parentResult.code).toBe(1);
    expect(parentResult.stderr).toContain("parent directory segments (..) are not allowed");
    await fs.rm(path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`), { force: true });

    expect(requests).toHaveLength(0);
  });

  test("publishes a web app manifest.json and leaves out only manifest.userland.json", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "PUT /v0/apps": publishResponse("app_pwa") });
    const dir = await temporaryAppDir({ app: { name: "Pwa" }, runtime: { static_root: "public", fallback: "index.html" } }, {
      "public/index.html": '<link rel="manifest" href="/manifest.json">',
      "public/manifest.json": JSON.stringify({ name: "Shop", short_name: "Shop", start_url: "/", display: "standalone", icons: [] })
    });

    const result = await runCli(["apps", "publish", dir, "--plan", "free"], api.baseUrl);

    expect(result.code).toBe(0);
    const body = requests.at(-1)?.body as { files: Array<{ path: string }> };
    expect(body.files.map((file) => file.path)).toEqual(["public/index.html", "public/manifest.json"]);
  });

  test("rejects a missing or empty value for --app, --account, and other flags", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "PUT /v0/apps": publishResponse("app_new") });

    const emptyApp = await runCli(["apps", "publish", "examples/hello-static", "--app", "", "--plan", "free"], api.baseUrl);
    expect(emptyApp.code).toBe(1);
    expect(emptyApp.stderr).toContain('--app requires a value, but it was empty. If you passed a variable such as "$APP_ID", check that it is set.');

    const trailingApp = await runCli(["apps", "publish", "examples/hello-static", "--app"], api.baseUrl);
    expect(trailingApp.code).toBe(1);
    expect(trailingApp.stderr).toContain("--app requires a value.");

    const appThenFlag = await runCli(["apps", "publish", "examples/hello-static", "--app", "--message", "hi"], api.baseUrl);
    expect(appThenFlag.code).toBe(1);
    expect(appThenFlag.stderr).toContain("--app requires a value.");

    const emptyAccount = await runCli(["apps", "list", "--account", " "], api.baseUrl);
    expect(emptyAccount.code).toBe(1);
    expect(emptyAccount.stderr).toContain("--account requires a value, but it was empty.");

    const emptyName = await runCli(["auth", "api-keys", "create", "--name", ""], api.baseUrl);
    expect(emptyName.code).toBe(1);
    expect(emptyName.stderr).toContain("--name requires a value");

    expect(requests).toHaveLength(0);
  });

  test("treats an empty USERLAND_ACCOUNT_ID as unset", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { "GET /v0/apps": { apps: [] } });
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_base_url: api.baseUrl, account_id: "acct_file" }));

    const result = await runCli(["apps", "list"], api.baseUrl, { apiKey: null, credentialsFile, env: { USERLAND_ACCOUNT_ID: "" } });

    expect(result.code).toBe(0);
    expect(requests.at(-1)?.accountId).toBe("acct_file");
  });

  test("encodes app ids and checks secret names before building request paths", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/app%2F..%2Fother/releases": { releases: [] },
      "GET /v0/apps/app%3Fx%3D1/events": { events: [], cursor: null },
      "POST /v0/apps/app%23frag/rollback": { app_id: "app#frag", release_id: "rel_1", previous_release_id: null, origin: "https://x.apps.userland.fun/", status: "live" },
      "PUT /v0/apps/app%2Fx/secrets/API_TOKEN": { name: "API_TOKEN", present: true, updated_at: "2026-05-05T00:00:00.000Z" },
      "PUT /v0/apps/app%20one": publishResponse("app one"),
      "DELETE /v0/apps/app%2F..%2Fother": unpublishResponse("app/../other"),
      "GET /v0/apps/app%2Fx/secrets": secretsResponse("app/x", ["API_TOKEN"]),
      "DELETE /v0/apps/app%2Fx/secrets/API_TOKEN": { name: "API_TOKEN", present: false },
      "POST /v0/apps/app%3Fx%3D1/admin-invites": inviteResponse([])
    });

    await expectCommand(["apps", "releases", "app/../other"], api.baseUrl, "");
    await expectCommand(["apps", "events", "app?x=1"], api.baseUrl, "");
    await expectCommand(["apps", "rollback", "app#frag", "rel_1"], api.baseUrl, "Rolled back");
    const secret = await runCli(["apps", "secrets", "set", "app/x", "API_TOKEN"], api.baseUrl, { stdin: "value" });
    expect(secret.code).toBe(0);
    await expectCommand(["apps", "publish", "examples/hello-static", "--app", "app one", "--plan", "free"], api.baseUrl, "Next: userland apps publish examples/hello-static --app 'app one'");
    await expectCommand(["apps", "unpublish", "app/../other", "--yes"], api.baseUrl, "Unpublished app/../other");
    await expectCommand(["apps", "secrets", "list", "app/x"], api.baseUrl, "API_TOKEN");
    await expectCommand(["apps", "secrets", "delete", "app/x", "API_TOKEN", "--yes"], api.baseUrl, "Deleted secret API_TOKEN from app/x.");
    await expectCommand(["apps", "invites", "create", "app?x=1", "--email", "jo@example.com"], api.baseUrl, "/_userland/auth/invite/");

    for (const args of [
      ["apps", "secrets", "set", "app_1", "FOO?x=1#"],
      ["apps", "secrets", "delete", "app_1", "FOO?x=1#", "--yes"],
      ["apps", "secrets", "delete", "app_1", "FOO/../..", "--yes"]
    ]) {
      const badName = await runCli(args, api.baseUrl, { stdin: "value" });
      expect(badName.code, args.join(" ")).toBe(1);
      expect(badName.stderr, args.join(" ")).toContain(`Invalid secret name: ${args[4]}.`);
    }
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /v0/apps/app%2F..%2Fother/releases",
      "GET /v0/apps/app%3Fx%3D1/events",
      "POST /v0/apps/app%23frag/rollback",
      "PUT /v0/apps/app%2Fx/secrets/API_TOKEN",
      "PUT /v0/apps/app%20one",
      "DELETE /v0/apps/app%2F..%2Fother",
      "GET /v0/apps/app%2Fx/secrets",
      "GET /v0/apps/app%2Fx/secrets",
      "DELETE /v0/apps/app%2Fx/secrets/API_TOKEN",
      "POST /v0/apps/app%3Fx%3D1/admin-invites"
    ]);
  });

  test("refuses . and .. as app ids, slugs, domains, and other path parts without sending a request", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "GET /v0/apps/%252e%252e": { app_id: "%2e%2e" }
    });
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ account_id: ".." }));

    // URL parsing drops "." and ".." parts, so `slugs remove app_1 ..` would become DELETE /v0/apps/app_1/,
    // which unpublishes the whole app, and `--app .` would become PUT /v0/apps/, which creates a new app.
    const cases: Array<{ args: string[]; stdin?: string; message: string }> = [
      { args: ["apps", "slugs", "remove", "app_1", ".."], message: 'Invalid slug: "..".' },
      { args: ["apps", "domains", "remove", "app_1", ".."], message: 'Invalid domain: "..".' },
      { args: ["apps", "domains", "verify", "app_1", "."], message: 'Invalid domain: ".".' },
      { args: ["apps", "secrets", "set", "..", "MODEL_KEY"], stdin: "v", message: 'Invalid app id: "..".' },
      { args: ["apps", "secrets", "list", ".."], message: 'Invalid app id: "..".' },
      { args: ["apps", "secrets", "delete", "..", "MODEL_KEY", "--yes"], message: 'Invalid app id: "..".' },
      { args: ["apps", "secrets", "delete", ".", "MODEL_KEY"], message: 'Invalid app id: ".".' },
      { args: ["apps", "invites", "create", ".", "--email", "jo@example.com"], message: 'Invalid app id: ".".' },
      { args: ["apps", "status", "."], message: 'Invalid app id: ".".' },
      { args: ["apps", "rollback", "..", "rel_1"], message: 'Invalid app id: "..".' },
      // `apps unpublish .` would otherwise become DELETE /v0/apps/, and `..` DELETE /v0/.
      { args: ["apps", "unpublish", ".", "--yes"], message: 'Invalid app id: ".".' },
      { args: ["apps", "unpublish", "..", "--yes"], message: 'Invalid app id: "..".' },
      { args: ["apps", "unpublish", ".."], message: 'Invalid app id: "..".' },
      { args: ["apps", "unpublish", "", "--yes"], message: 'Invalid app id: "".' },
      { args: ["apps", "analytics", ".."], message: 'Invalid app id: "..".' },
      { args: ["apps", "publish", "examples/hello-static", "--app", "."], message: 'Invalid app id: ".".' },
      { args: ["apps", "publish", "examples/hello-static", "--app", "..", "--plan", "free"], message: 'Invalid app id: "..".' },
      { args: ["auth", "api-keys", "revoke", "..", "--yes"], message: 'Invalid API key id: "..".' },
      { args: ["accounts", "limits", "--account", "."], message: 'Invalid account id: ".".' },
      // A saved account id is checked too.
      { args: ["accounts", "status"], message: 'Invalid account id: "..".' }
    ];
    for (const { args, stdin, message } of cases) {
      const result = await runCli(args, api.baseUrl, { stdin, credentialsFile });
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain(message);
      expect(result.stdout, args.join(" ")).not.toContain("Published");
    }
    expect(requests).toHaveLength(0);

    // Anything else, including a percent-encoded dot, is sent encoded and keeps its place in the path.
    const encoded = await runCli(["apps", "status", "%2e%2e"], api.baseUrl, { credentialsFile });
    expect(encoded.code).toBe(0);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v0/apps/%252e%252e"]);
  });

  test("accepts --value and other free-text values that start with dashes, such as a PEM key", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "PUT /v0/apps/app_1/secrets/GITHUB_APP_PRIVATE_KEY": { name: "GITHUB_APP_PRIVATE_KEY", present: true, updated_at: "2026-05-05T00:00:00.000Z" },
      "POST /v0/support/requests": { correlation_id: "sup_1", reply_to_email: "owner@example.com" }
    });
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----";

    const secret = await runCli(["apps", "secrets", "set", "app_1", "GITHUB_APP_PRIVATE_KEY", "--value", pem], api.baseUrl);
    expect(secret.code).toBe(0);
    expect(secret.stderr).toContain("warning=secret_on_command_line");
    expect(requests.at(-1)?.body).toEqual({ value: pem });

    const support = await runCli(["support", "open", "--subject", "--help did not work", "--message", "-- see logs"], api.baseUrl);
    expect(support.code).toBe(0);
    expect(requests.at(-1)?.body).toEqual({ subject: "--help did not work", message: "-- see logs" });

    // A value that is exactly another option is still a mistake, such as a forgotten value before --account.
    const forgotten = await runCli(["apps", "secrets", "set", "app_1", "API_TOKEN", "--value", "--account", "acct_1"], api.baseUrl);
    expect(forgotten.code).toBe(1);
    expect(forgotten.stderr).toContain("--value requires a value. The next argument (--account) looks like another option.");
    expect(requests).toHaveLength(2);
  });

  test("warns when a secret or API key is passed on the command line and reads them from stdin", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, {
      "PUT /v0/apps/app_ops/secrets/API_TOKEN": { name: "API_TOKEN", present: true, updated_at: "2026-05-05T00:00:00.000Z" }
    });

    const flag = await runCli(["apps", "secrets", "set", "app_ops", "API_TOKEN", "--value", "super-secret"], api.baseUrl);
    expect(flag.code).toBe(0);
    expect(flag.stderr).toContain("warning=secret_on_command_line");
    expect(flag.stderr).not.toContain("super-secret");

    const piped = await runCli(["apps", "secrets", "set", "app_ops", "API_TOKEN"], api.baseUrl, { stdin: "piped-secret\n" });
    expect(piped.code).toBe(0);
    expect(piped.stderr).toBe("");
    expect(requests.at(-1)?.body).toEqual({ value: "piped-secret" });

    const credentialsFile = await temporaryCredentialsFile();
    const saveFlag = await runCli(["auth", "save-key", "--api-key", "flag_key"], api.baseUrl, { apiKey: null, credentialsFile });
    expect(saveFlag.code).toBe(0);
    expect(saveFlag.stderr).toContain("warning=api_key_on_command_line");

    const savePiped = await runCli(["auth", "save-key"], api.baseUrl, { apiKey: null, credentialsFile, stdin: "piped_key\n" });
    expect(savePiped.code).toBe(0);
    expect(savePiped.stderr).toBe("");
    expect(savePiped.stdout).not.toContain("piped_key");
    const saved = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ api_key: "piped_key", api_base_url: api.baseUrl });
    expect(requests).toHaveLength(2);
  });

  test("sends USERLAND_API_KEY and a saved key only to their own API", async () => {
    const requests: RequestRecord[] = [];
    const savedApi = await startMockApi(requests, { "GET /v0/apps": { apps: [] } });
    const otherApi = await startMockApi(requests, { "GET /v0/apps": { apps: [] } });
    const credentialsFile = await temporaryCredentialsFile();
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(credentialsFile, JSON.stringify({ api_key: "saved_key", api_key_id: "apk_saved", api_base_url: savedApi.baseUrl }));

    // A saved key is not sent to a different USERLAND_API_BASE_URL.
    const mismatch = await runCli(["apps", "list"], otherApi.baseUrl, { apiKey: null, credentialsFile });
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain(`The saved API key is for ${savedApi.baseUrl}, but USERLAND_API_BASE_URL is ${otherApi.baseUrl}.`);
    expect(requests).toHaveLength(0);

    // Without USERLAND_API_BASE_URL, the saved key goes to its own API, with a note that it is not the default.
    const saved = await runCli(["apps", "list"], savedApi.baseUrl, { apiKey: null, credentialsFile, env: { USERLAND_API_BASE_URL: undefined } });
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
    const insecure = await runCli(["apps", "list"], "http://api.userland.test", {});
    expect(insecure.code).toBe(1);
    expect(insecure.stderr).toContain("API base URL must start with https:// (http:// is allowed only for localhost): http://api.userland.test");

    const credentialsFile = await temporaryCredentialsFile();
    const saveKey = await runCli(["auth", "save-key", "--api-base-url", "http://api.userland.test"], "http://127.0.0.1:1", { apiKey: null, credentialsFile, stdin: "key" });
    expect(saveKey.code).toBe(1);
    await expect(fs.stat(credentialsFile)).rejects.toMatchObject({ code: "ENOENT" });

    const withPassword = await runCli(["apps", "list"], "https://user:pass@api.userland.test", {});
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
    const malformed = await runCli(["apps", "list"], "http://127.0.0.1:1", { apiKey: null, credentialsFile });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain(`Credentials file ${credentialsFile} is not valid JSON.`);
    expect(malformed.stderr).not.toContain("ul_live_SU");
  });

  test("shows control characters from the API as visible escapes, except in --json output", async () => {
    const requests: RequestRecord[] = [];
    const hostile = "bad input \u001b]0;pwned\u0007\u001b[2K\nFAKE: all good\u009b31m";
    const analytics = analyticsResponse();
    analytics.recent_errors[0].message = hostile;
    const api = await startMockApi(requests, {
      "GET /v0/apps/app_ops/events": {
        events: [{ app_event_id: "evt_1", type: "app.log", severity: "warn", message: hostile, release_id: "rel_1", created_at: "2026-05-05T00:00:00.000Z" }],
        cursor: null
      },
      "GET /v0/apps/app_ops/analytics": [analytics, analytics],
      "GET /v0/apps/app_ops/releases": { __status: 400, error: { code: "bad_request", message: "no \u001b[31mway" } }
    });

    const events = await runCli(["apps", "events", "app_ops"], api.baseUrl);
    expect(events.code).toBe(0);
    expect(events.stdout).toContain("bad input \\x1b]0;pwned\\x07\\x1b[2K\\nFAKE: all good\\x9b31m");
    expect(events.stdout).not.toContain("\u001b");
    expect(events.stdout.split("\n").filter(Boolean)).toHaveLength(1);

    const human = await runCli(["apps", "analytics", "app_ops"], api.baseUrl);
    expect(human.stdout).toContain("\\x1b]0;pwned");
    expect(human.stdout).not.toContain("\u001b");

    const json = await runCli(["apps", "analytics", "app_ops", "--json"], api.baseUrl);
    expect((JSON.parse(json.stdout) as { recent_errors: Array<{ message: string }> }).recent_errors[0].message).toBe(hostile);

    const failed = await runCli(["apps", "releases", "app_ops"], api.baseUrl);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("API 400: no \\x1b[31mway");
    expect(failed.stderr).not.toContain("\u001b");
  });
});

describe("apps download", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  /** The file list and file reads the API answers for a version made from a folder, with some types the CLI wouldn't guess. */
  async function versionOf(appId: string, releaseId: string, dir: string, overrides: Record<string, string> = {}) {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.userland.json"), "utf8")) as Record<string, unknown>;
    const paths: string[] = [];
    const walk = async (relative: string) => {
      for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(child);
        else if (child !== "manifest.userland.json") paths.push(child);
      }
    };
    await walk("");
    paths.sort();
    const guess = (file: string) =>
      file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
    const contents = new Map<string, Buffer>();
    for (const file of paths) contents.set(file, await fs.readFile(path.join(dir, file)));
    const files = paths.map((file) => ({ path: file, kind: "static", content_type: overrides[file] ?? guess(file), size_bytes: contents.get(file)!.length, sha256: sha256(contents.get(file)!) }));
    const routes: Record<string, unknown> = {
      [`GET /v0/apps/${appId}/releases/live/files`]: {
        app_id: appId,
        account_id: "acct_owner",
        release_id: releaseId,
        is_live: true,
        activation_status: "live",
        message: "Spring prices",
        created_at: "2026-10-06T12:00:00.000Z",
        manifest: { app: manifest.app, runtime: manifest.runtime, resources: { ...(manifest.resources as object), secrets: { required: ["STRIPE_SECRET_KEY"] } } },
        file_count: files.length,
        total_bytes: files.reduce((total, file) => total + file.size_bytes, 0),
        files,
        kept_until_at_least: "2026-10-06T12:30:00.000Z"
      }
    };
    for (const file of files) {
      routes[`GET /v0/apps/${appId}/releases/${releaseId}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`] = { __raw: contents.get(file.path)! };
    }
    return { routes, files, contents, manifest };
  }

  async function emptyDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "userland-download-"));
    tempDirs.push(dir);
    return dir;
  }

  test("writes a version into a folder that publishes again with the same files, types and settings", async () => {
    const version = await versionOf("app_dl", "rel_dl", "examples/hello-static", { "example.json": "application/json" });
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, { ...version.routes, "PUT /v0/apps/app_dl": publishResponse("app_dl") });
    const parent = await emptyDir();
    const target = path.join(parent, "hello");

    const result = await runCli(["apps", "download", "app_dl", target], api.baseUrl);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Downloaded ${version.files.length} files of the live version to ${target}\n`);
    expect(result.stdout).toContain(`app_id=app_dl\nrelease_id=rel_dl\ndir=${target}\nfile_count=${version.files.length}\nrequired_secret=STRIPE_SECRET_KEY\n`);
    expect(result.stdout).toContain(`Next: userland validate ${target}\nNext: userland apps publish ${target} --app app_dl\n`);
    for (const file of version.files) {
      expect(await fs.readFile(path.join(target, file.path)), file.path).toEqual(version.contents.get(file.path));
    }
    const manifest = JSON.parse(await fs.readFile(path.join(target, "manifest.userland.json"), "utf8")) as Record<string, any>;
    expect(manifest).toMatchObject({ app: version.manifest.app, runtime: version.manifest.runtime, message: "Spring prices", resources: { secrets: { required: ["STRIPE_SECRET_KEY"] } } });
    expect(manifest.files).toEqual(version.files.map((file) => (file.path === "example.json" ? { path: file.path, content_type: "application/json" } : { path: file.path })));

    const published = await runCli(["apps", "publish", target, "--app", "app_dl", "--skip-local-validation"], api.baseUrl);
    expect(published.code, published.stderr).toBe(0);
    const body = requests.find((request) => request.method === "PUT")?.body as { files: Array<{ path: string; content_type: string; content_base64: string }>; message: string; app: unknown };
    expect(body.message).toBe("Spring prices");
    expect(body.app).toEqual(version.manifest.app);
    expect(body.files.map((file) => ({ path: file.path, content_type: file.content_type, sha256: sha256(Buffer.from(file.content_base64, "base64")) }))).toEqual(
      version.files.map((file) => ({ path: file.path, content_type: file.content_type, sha256: file.sha256 }))
    );
  });

  test("refuses paths that would land outside the folder, before writing anything", async () => {
    for (const bad of ["../evil.txt", "/etc/passwd", "public\\win.txt", "public/../../x.txt", "public//x.txt", "C:/x.txt"]) {
      const version = await versionOf("app_bad", "rel_bad", "examples/hello-static");
      const list = version.routes["GET /v0/apps/app_bad/releases/live/files"] as { files: Array<{ path: string }> };
      list.files.push({ ...list.files[0], path: bad });
      const api = await startMockApi([], version.routes);
      const target = path.join(await emptyDir(), "out");
      const result = await runCli(["apps", "download", "app_bad", target], api.baseUrl);
      expect(result.code, bad).toBe(1);
      expect(result.stderr, bad).toContain("Nothing was downloaded.");
      expect(await fs.readdir(target).catch(() => []), bad).toEqual([]);
    }
  });

  test("keeps no file whose bytes don't match the version's SHA-256", async () => {
    const version = await versionOf("app_sha", "rel_sha", "examples/hello-static");
    version.routes["GET /v0/apps/app_sha/releases/rel_sha/files/public/index.html"] = { __raw: "<h1>changed</h1>" };
    const api = await startMockApi([], version.routes);
    const target = path.join(await emptyDir(), "out");
    const result = await runCli(["apps", "download", "app_sha", target], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("public/index.html arrived with");
    await expect(fs.access(path.join(target, "public/index.html"))).rejects.toThrow();
  });

  test("needs --force for a folder that isn't empty, and never writes through a symlink", async () => {
    const version = await versionOf("app_dir", "rel_dir", "examples/hello-static");
    const api = await startMockApi([], version.routes);
    const target = await emptyDir();
    await fs.writeFile(path.join(target, "notes.txt"), "mine");
    const refused = await runCli(["apps", "download", "app_dir", target], api.baseUrl);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("is not empty. Choose an empty or new folder, or pass --force to write into it.");

    const outside = await emptyDir();
    await fs.symlink(outside, path.join(target, "public"));
    const linked = await runCli(["apps", "download", "app_dir", target, "--force"], api.baseUrl);
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain("is a symlink, so the CLI won't write into it.");
    expect(await fs.readdir(outside)).toEqual([]);

    await fs.rm(path.join(target, "public"));
    const forced = await runCli(["apps", "download", "app_dir", target, "--force"], api.baseUrl);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await fs.readFile(path.join(target, "notes.txt"), "utf8")).toBe("mine");
  });

  test("works as apps pull with --version and --json, checks the account, and waits when the file-read limit says so", async () => {
    const version = await versionOf("app_v", "rel_old", "examples/hello-static");
    const routes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(version.routes)) routes[key.replace("/releases/live/files", "/releases/rel_old/files")] = value;
    (routes["GET /v0/apps/app_v/releases/rel_old/files"] as { is_live: boolean }).is_live = false;
    const css = "GET /v0/apps/app_v/releases/rel_old/files/public/assets/app.css";
    routes[css] = [{ __status: 429, error: { code: "rate_limited", message: "Too many file reads. Wait a minute, then continue." } }, routes[css]];
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, routes);
    const target = path.join(await emptyDir(), "old");

    const result = await runCli(["apps", "pull", "app_v", target, "--version", "rel_old", "--json", "--account", "acct_owner"], api.baseUrl);
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({ app_id: "app_v", account_id: "acct_owner", release_id: "rel_old", is_live: false, dir: target, file_count: version.files.length, required_secrets: ["STRIPE_SECRET_KEY"] });
    expect(json.files).toEqual(version.files.map((file) => ({ path: file.path, size_bytes: file.size_bytes, sha256: file.sha256 })));
    expect(requests.filter((request) => request.url.endsWith("public/assets/app.css"))).toHaveLength(2);
    expect(requests.every((request) => request.accountId === "acct_owner")).toBe(true);

    const elsewhere = await runCli(["apps", "pull", "app_v", path.join(await emptyDir(), "x"), "--version", "rel_old", "--account", "acct_other"], api.baseUrl);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.stderr).toContain("app_v belongs to account acct_owner, not acct_other. Nothing was downloaded.");

    const gone = await runCli(["apps", "download", "app_v", path.join(await emptyDir(), "y"), "--version", "rel_gone"], api.baseUrl);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("API 404");
  });
});

describe("apps export", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  async function emptyDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "userland-export-"));
    tempDirs.push(dir);
    return dir;
  }

  function exportRoutes(): Record<string, unknown> {
    const record = (id: string, data: Record<string, unknown>) => ({ id, data, owner_app_user_id: id === "r1" ? "appusr_a" : null, created_at: "2026-10-06T12:00:00.000Z", updated_at: "2026-10-06T12:30:00.000Z" });
    const logo = Buffer.from("PNG!");
    const photo = Buffer.from("JPG!");
    const file = (id: string, store: string, filePath: string, bytes: Buffer) => ({
      id,
      store,
      path: filePath,
      content_type: "image/png",
      size_bytes: bytes.length,
      sha256: sha256(bytes),
      metadata: {},
      created_at: "2026-10-06T12:40:00.000Z",
      updated_at: "2026-10-06T12:40:00.000Z"
    });
    return {
      "GET /v0/apps/app_x/data": { app_id: "app_x", account_id: "acct_owner", collections: [{ name: "orders", record_count: 3 }, { name: "notes", record_count: 0 }] },
      "GET /v0/apps/app_x/data/orders?limit=1000": {
        app_id: "app_x",
        account_id: "acct_owner",
        collection: "orders",
        records: [record("r1", { item: "Cake", total: 12 }), record("r2", { item: "=HYPERLINK(\"http://evil.example\")", note: "a, \"quoted\"\nline" })],
        next_cursor: "c1"
      },
      "GET /v0/apps/app_x/data/orders?limit=1000&cursor=c1": { app_id: "app_x", account_id: "acct_owner", collection: "orders", records: [record("r3", { item: "Pie", tags: ["x"] })], next_cursor: null },
      "GET /v0/apps/app_x/data/notes?limit=1000": { app_id: "app_x", account_id: "acct_owner", collection: "notes", records: [], next_cursor: null },
      "GET /v0/apps/app_x/app-users?limit=1000": {
        app_id: "app_x",
        account_id: "acct_owner",
        app_users: [
          { id: "appusr_a", email: "ada@customer.example", roles: ["admin", "staff"], created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", disabled_at: null },
          { id: "appusr_b", email: "+bo@customer.example", roles: [], created_at: "2026-10-02T00:00:00.000Z", updated_at: "2026-10-03T00:00:00.000Z", disabled_at: "2026-10-03T00:00:00.000Z" }
        ],
        next_cursor: null
      },
      "GET /v0/apps/app_x/files?limit=1000": { app_id: "app_x", account_id: "acct_owner", files: [file("file_1", "media", "logo.png", logo), file("file_2", "media", "photos/été.jpg", photo)], next_cursor: null },
      "GET /v0/apps/app_x/files/file_1": { __raw: logo },
      "GET /v0/apps/app_x/files/file_2": { __raw: photo }
    };
  }

  test("writes records, people and uploaded files into a folder, with spreadsheet formulas escaped", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, exportRoutes());
    const target = path.join(await emptyDir(), "data");

    const result = await runCli(["apps", "export", "app_x", target], api.baseUrl);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Exported the saved data of app_x to ${target}\napp_id=app_x\ndir=${target}\ncollections=2\nrecords=3\npeople=2\nfiles=2\nfile_bytes=8\n`);

    const orders = JSON.parse(await fs.readFile(path.join(target, "records", "orders.json"), "utf8"));
    expect(orders.map((record: { id: string }) => record.id)).toEqual(["r1", "r2", "r3"]);
    expect(orders[0]).toEqual({ id: "r1", created_at: "2026-10-06T12:00:00.000Z", updated_at: "2026-10-06T12:30:00.000Z", owner_app_user_id: "appusr_a", data: { item: "Cake", total: 12 } });
    expect(JSON.parse(await fs.readFile(path.join(target, "records", "notes.json"), "utf8"))).toEqual([]);

    const csv = await fs.readFile(path.join(target, "records", "orders.csv"), "utf8");
    expect(csv.split("\r\n")[0]).toBe("id,created_at,updated_at,owner_app_user_id,item,note,tags,total");
    expect(csv).toContain("r1,2026-10-06T12:00:00.000Z,2026-10-06T12:30:00.000Z,appusr_a,Cake,,,12\r\n");
    expect(csv).toContain(`r2,2026-10-06T12:00:00.000Z,2026-10-06T12:30:00.000Z,,"'=HYPERLINK(""http://evil.example"")","a, ""quoted""\nline",,\r\n`);
    expect(csv).toContain('r3,2026-10-06T12:00:00.000Z,2026-10-06T12:30:00.000Z,,Pie,,"[""x""]",\r\n');

    const people = await fs.readFile(path.join(target, "people.csv"), "utf8");
    expect(people).toBe(
      "id,email,roles,created_at,updated_at,disabled_at\r\n" +
        "appusr_a,ada@customer.example,admin;staff,2026-10-01T00:00:00.000Z,2026-10-01T00:00:00.000Z,\r\n" +
        "appusr_b,'+bo@customer.example,,2026-10-02T00:00:00.000Z,2026-10-03T00:00:00.000Z,2026-10-03T00:00:00.000Z\r\n"
    );
    expect(JSON.parse(await fs.readFile(path.join(target, "people.json"), "utf8"))).toHaveLength(2);
    expect(await fs.readFile(path.join(target, "files", "media", "photos", "été.jpg"), "utf8")).toBe("JPG!");
    expect(await fs.readFile(path.join(target, "files", "index.csv"), "utf8")).toContain("media,photos/été.jpg,image/png,4,");
    expect(await fs.readFile(path.join(target, "README.txt"), "utf8")).toContain("Not included: passwords");
  });

  test("saves one collection with --collection, leaves files out with --no-files, and checks the account", async () => {
    const requests: RequestRecord[] = [];
    const api = await startMockApi(requests, exportRoutes());
    const one = path.join(await emptyDir(), "one");
    const result = await runCli(["apps", "export", "app_x", one, "--collection", "orders", "--json"], api.baseUrl);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ app_id: "app_x", collections: 1, records: 3, people: 0, files: 0 });
    expect((await fs.readdir(one)).sort()).toEqual(["README.txt", "records"]);
    expect(requests.some((request) => request.url.includes("/app-users") || request.url.includes("/files"))).toBe(false);

    const noFiles = path.join(await emptyDir(), "nofiles");
    const skipped = await runCli(["apps", "export", "app_x", noFiles, "--no-files"], api.baseUrl);
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain("files=skipped\n");
    await expect(fs.access(path.join(noFiles, "files"))).rejects.toThrow();

    const other = await runCli(["apps", "export", "app_x", path.join(await emptyDir(), "x"), "--account", "acct_other"], api.baseUrl);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("app_x belongs to account acct_owner, not acct_other. Nothing was exported.");
  });

  test("passes the API's refusal through for a role that can't export", async () => {
    const api = await startMockApi([], { "GET /v0/apps/app_x/data": { __status: 403, error: { code: "forbidden", message: "Your account role cannot perform this operation." } } });
    const result = await runCli(["apps", "export", "app_x", path.join(await emptyDir(), "x")], api.baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("API 403: Your account role cannot perform this operation.");
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
  options: { accountId?: string; apiKey?: string | null; credentialsFile?: string; stdin?: string; tty?: boolean; env?: Record<string, string | undefined> } = {}
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
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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

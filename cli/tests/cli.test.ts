import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

interface RequestRecord {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

const servers: Array<{ close: () => Promise<void> }> = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("public CLI", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
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
});

async function expectCommand(args: string[], baseUrl: string, stdoutNeedle: string): Promise<void> {
  const result = await runCli(args, baseUrl);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(stdoutNeedle);
}

async function runCli(args: string[], apiBaseUrl: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join("cli", "src", "index.ts"), ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        USERLAND_API_KEY: "test_api_key",
        USERLAND_API_BASE_URL: apiBaseUrl
      },
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
    body: rawBody ? JSON.parse(rawBody) : undefined
  });

  if (!(key in routes)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: key } }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(routes[key]));
}

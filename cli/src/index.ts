#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_API_BASE_URL = "https://api.userland.fun";

interface CliOptions {
  app?: string;
  message?: string;
}

interface SecretSetOptions {
  value?: string;
}

interface EventsOptions {
  type?: string;
  severity?: string;
  releaseId?: string;
  limit?: string;
}

interface PublishResponse {
  status: string;
  app_id: string;
  release_id: string;
  origin: string;
  previous_release_id: string | null;
  activation: {
    status: string;
    reasons: string[];
    previous_release_id: string | null;
  };
}

interface VersionResponse {
  releases: Array<{
    release_id: string;
    created_at: string;
    is_live: boolean;
    activation_status: string;
    message: string | null;
  }>;
}

interface AppsResponse {
  apps: Array<{
    app_id: string;
    name: string;
    origin: string;
    live_release_id: string | null;
    updated_at: string;
  }>;
}

interface RollbackResponse {
  app_id: string;
  release_id: string;
  previous_release_id: string | null;
  origin: string;
  status: string;
}

interface EventsResponse {
  events: Array<{
    app_event_id: string;
    type: string;
    severity: string;
    message: string;
    release_id: string | null;
    created_at: string;
  }>;
  cursor: string | null;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "apps") {
    await appsCommand(args);
    return;
  }

  if (command === "publish") {
    await publishCommand(args);
    return;
  }

  if (command === "releases" || command === "versions") {
    await releasesCommand(args);
    return;
  }

  usage(1);
}

async function appsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "publish") {
    await publishCommand(rest);
    return;
  }
  if (subcommand === "list") {
    await listAppsCommand();
    return;
  }
  if (subcommand === "releases") {
    await releasesCommand(rest);
    return;
  }
  if (subcommand === "rollback") {
    await rollbackCommand(rest);
    return;
  }
  if (subcommand === "secrets" && rest[0] === "set") {
    await setSecretCommand(rest.slice(1));
    return;
  }
  if (subcommand === "events") {
    await eventsCommand(rest);
    return;
  }
  usage(1);
}

async function publishCommand(args: string[]): Promise<void> {
  const dir = args[0];
  const options = parseOptions(args.slice(1));
  if (!dir) {
    usage(1);
  }

  const body = await readPublishDirectory(dir, options);
  const response = await apiFetch<PublishResponse>(options.app ? `/v0/apps/${options.app}` : "/v0/apps", {
    method: "PUT",
    body: JSON.stringify(body)
  });

  console.log(`Published ${response.origin}`);
  console.log(`app_id=${response.app_id}`);
  console.log(`release_id=${response.release_id}`);
  console.log(`previous_release_id=${response.previous_release_id ?? ""}`);
  console.log(`activation_status=${response.activation.status}`);
  if (response.activation.reasons.length > 0) {
    console.log(`activation_reasons=${response.activation.reasons.join("; ")}`);
  }
}

async function listAppsCommand(): Promise<void> {
  const response = await apiFetch<AppsResponse>("/v0/apps", {
    method: "GET"
  });

  for (const app of response.apps) {
    console.log(`${app.app_id}\t${app.live_release_id ?? ""}\t${app.updated_at}\t${app.name}\t${app.origin}`);
  }
}

async function releasesCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (!appId) {
    usage(1);
  }

  const response = await apiFetch<VersionResponse>(`/v0/apps/${appId}/releases`, {
    method: "GET"
  });

  for (const release of response.releases) {
    const live = release.is_live ? " live" : "";
    console.log(`${release.release_id}${live}\t${release.activation_status}\t${release.created_at}\t${release.message ?? ""}`);
  }
}

async function rollbackCommand(args: string[]): Promise<void> {
  const [appId, releaseId] = args;
  if (!appId || !releaseId) {
    usage(1);
  }

  const response = await apiFetch<RollbackResponse>(`/v0/apps/${appId}/rollback`, {
    method: "POST",
    body: JSON.stringify({ release_id: releaseId })
  });

  console.log(`Rolled back ${response.origin}`);
  console.log(`app_id=${response.app_id}`);
  console.log(`release_id=${response.release_id}`);
  console.log(`previous_release_id=${response.previous_release_id ?? ""}`);
  console.log(`status=${response.status}`);
}

async function setSecretCommand(args: string[]): Promise<void> {
  const [appId, name, ...optionArgs] = args;
  if (!appId || !name) {
    usage(1);
  }
  const options = parseSecretSetOptions(optionArgs);
  const value = options.value ?? (await readStdin()).trimEnd();
  if (!value) {
    throw new Error("Secret value is required on stdin or with --value.");
  }

  const response = await apiFetch<{ name: string; present: boolean; updated_at: string }>(`/v0/apps/${appId}/secrets/${name}`, {
    method: "PUT",
    body: JSON.stringify({ value })
  });

  console.log(`secret=${response.name}`);
  console.log(`present=${response.present}`);
  console.log(`updated_at=${response.updated_at}`);
}

async function eventsCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (!appId) {
    usage(1);
  }
  const options = parseEventsOptions(args.slice(1));
  const params = new URLSearchParams();
  if (options.type) params.set("type", options.type);
  if (options.severity) params.set("severity", options.severity);
  if (options.releaseId) params.set("release_id", options.releaseId);
  if (options.limit) params.set("limit", options.limit);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await apiFetch<EventsResponse>(`/v0/apps/${appId}/events${suffix}`, {
    method: "GET"
  });

  for (const event of response.events) {
    console.log(`${event.created_at}\t${event.severity}\t${event.type}\t${event.release_id ?? ""}\t${event.message}`);
  }
  if (response.cursor) {
    console.log(`cursor=${response.cursor}`);
  }
}

async function readPublishDirectory(rootDir: string, options: CliOptions): Promise<Record<string, unknown>> {
  const absoluteRoot = path.resolve(rootDir);
  const stat = await fs.stat(absoluteRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Directory not found: ${rootDir}`);
  }

  const manifest = await readManifest(absoluteRoot);
  const files = await readReleaseFiles(absoluteRoot, manifest);
  const app = objectValue(manifest.app) ?? {
    name: path.basename(absoluteRoot)
  };
  const runtime = objectValue(manifest.runtime) ?? {
    static_root: "public",
    fallback: "index.html"
  };
  const resources = objectValue(manifest.resources) ?? {};
  const provenance = objectValue(manifest.provenance) ?? {};

  return {
    app,
    runtime,
    resources,
    files,
    message: options.message ?? stringValue(manifest.message),
    provenance
  };
}

async function readReleaseFiles(rootDir: string, manifest: Record<string, unknown>): Promise<Array<{ path: string; content_type: string; content_base64: string }>> {
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : null;
  const publishFiles =
    manifestFiles && manifestFiles.length > 0
      ? manifestFiles.map(async (entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new Error("manifest.userland.json files entries must be objects.");
          }
          const file = entry as { path?: unknown; content_type?: unknown };
          if (typeof file.path !== "string") {
            throw new Error("manifest.userland.json files entries require path.");
          }
          const contents = await fs.readFile(path.join(rootDir, file.path));
          return {
            path: file.path,
            content_type: typeof file.content_type === "string" ? file.content_type : contentTypeForPath(file.path),
            content_base64: contents.toString("base64")
          };
        })
      : (await walk(rootDir))
          .filter((filePath) => !isManifestFile(filePath))
          .sort()
          .map(async (filePath) => {
            const relativePath = path.relative(rootDir, filePath).split(path.sep).join("/");
            const contents = await fs.readFile(filePath);
            return {
              path: relativePath,
              content_type: contentTypeForPath(relativePath),
              content_base64: contents.toString("base64")
            };
          });
  const files = await Promise.all(publishFiles);

  if (files.length === 0) {
    throw new Error("Publish directory must contain at least one file.");
  }

  return files;
}

async function readManifest(rootDir: string): Promise<Record<string, unknown>> {
  const userlandManifestPath = path.join(rootDir, "manifest.userland.json");
  const legacyManifestPath = path.join(rootDir, "manifest.json");
  let manifestPath = userlandManifestPath;
  let contents = await fs.readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!contents) {
    manifestPath = legacyManifestPath;
    contents = await fs.readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
  }

  if (!contents) {
    return {};
  }

  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("manifest.json must contain a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function isManifestFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return basename === "manifest.userland.json" || basename === "manifest.json";
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return await walk(entryPath);
      }
      if (entry.isFile()) {
        return [entryPath];
      }
      return [];
    })
  );
  return files.flat();
}

async function apiFetch<T>(apiPath: string, init: RequestInit): Promise<T> {
  const apiKey = process.env.USERLAND_API_KEY;
  if (!apiKey) {
    throw new Error("USERLAND_API_KEY is required.");
  }

  const baseUrl = process.env.USERLAND_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const response = await fetch(`${baseUrl.replace(/\/$/u, "")}${apiPath}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...init.headers
    }
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const message = errorMessage(body) ?? response.statusText;
    throw new Error(`API ${response.status}: ${message}`);
  }

  return body as T;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--app") {
      options.app = args[++index];
    } else if (arg === "--message") {
      options.message = args[++index];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseSecretSetOptions(args: string[]): SecretSetOptions {
  const options: SecretSetOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--value") {
      options.value = args[++index];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseEventsOptions(args: string[]): EventsOptions {
  const options: EventsOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--type") {
      options.type = args[++index];
    } else if (arg === "--severity") {
      options.severity = args[++index];
    } else if (arg === "--release") {
      options.releaseId = args[++index];
    } else if (arg === "--limit") {
      options.limit = args[++index];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8"
  };
  return types[ext] ?? "application/octet-stream";
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }

  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }

  const typedError = error as { code?: unknown; message?: unknown };
  const message = typeof typedError.message === "string" ? typedError.message : undefined;
  const code = typeof typedError.code === "string" ? typedError.code : undefined;
  if (code && message) {
    return `${code}: ${message}`;
  }
  return message ?? code;
}

function usage(exitCode: number): never {
  console.error(`Usage:
  userland apps publish <dir> [--app <app-id>] [--message <message>]
  userland apps list
  userland apps releases <app-id>
  userland apps rollback <app-id> <release-id>
  userland apps secrets set <app-id> <NAME> [--value <value>]
  userland apps events <app-id> [--type <event-type>] [--severity <level>] [--release <release-id>] [--limit <n>]

Aliases:
  userland publish <dir> [--app <app-id>] [--message <message>]
  userland releases <app-id>`);
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

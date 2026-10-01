#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { terminalSafe, terminalSafeLines, terminalSafeValue } from "./terminal.js";
import {
  analyzeAppDirectory,
  applyPlan,
  findManifest,
  formatValidationReport,
  formatWarning,
  isSelfServePlan,
  LIMITS_DOCS_URL,
  listReleaseFiles,
  normalizePlanKey,
  planDisplayName,
  privateKeyMessage,
  publicPlanKeys,
  releaseFileProblem,
  releaseListingWarnings,
  validateAppDirectory,
  validationExitCode,
  validationJson,
  type EntitlementConfig,
  type ManifestLimitValue,
  type ValidationReport
} from "./validation.js";

const DEFAULT_API_BASE_URL = "https://api.userland.fun";
const DEFAULT_CONSOLE_BASE_URL = "https://console.userland.fun";
const CLI_VERSION = readCliVersion();

function readCliVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Unable to read CLI package version");
  }

  return packageJson.version;
}

interface CliOptions {
  account?: string;
  app?: string;
  message?: string;
  plan?: string;
  skipLocalValidation?: boolean;
}

interface ValidateOptions {
  json?: boolean;
  plan?: string;
  strict?: boolean;
}

interface AnalyticsOptions {
  account?: string;
  json?: boolean;
  range?: string;
}

interface SupportOptions {
  account?: string;
  app?: string;
  json?: boolean;
  message?: string;
  subject?: string;
}

interface SecretSetOptions {
  account?: string;
  value?: string;
}

interface SecretsListOptions {
  account?: string;
  json?: boolean;
}

interface SecretDeleteOptions {
  account?: string;
  yes?: boolean;
}

interface InviteCreateOptions {
  account?: string;
  email?: string;
  expiresInDays?: string;
  json?: boolean;
  roles: string[];
}

interface EventsOptions {
  account?: string;
  type?: string;
  severity?: string;
  releaseId?: string;
  limit?: string;
  cursor?: string;
}

interface UnpublishOptions {
  account?: string;
  json?: boolean;
  yes?: boolean;
}

interface DowngradePreviewOptions {
  account?: string;
  to?: string;
}

interface ApiKeyOptions {
  name?: string;
  yes?: boolean;
}

interface AuthOptions {
  account?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  consoleUrl?: string;
  email?: string;
  noBrowser?: boolean;
  revoke?: boolean;
  save?: boolean;
}

interface CredentialsFile {
  account_id?: string;
  api_base_url?: string;
  api_key?: string;
  api_key_id?: string;
  console_url?: string;
  updated_at?: string;
  username?: string;
}

type CredentialsUpdate = {
  [Key in keyof CredentialsFile]?: CredentialsFile[Key] | null;
};

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type DevicePollResponse =
  | {
      ok: true;
      status: "approved";
      api_key: string;
      api_key_id?: string;
      username?: string;
      accounts?: AccountsResponse["accounts"];
      default_account_id?: string;
    }
  | {
      ok: false;
      status: "authorization_pending" | "slow_down" | "denied" | "expired" | "consumed";
      interval?: number;
    };

interface ApiKeyRevokeResponse {
  ok: true;
  revoked: boolean;
  api_key_id: string;
  key?: ApiKeySummary;
}

interface ApiKeySummary {
  id: string;
  api_key_id: string;
  key_prefix: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ApiKeyListResponse {
  api_keys: ApiKeySummary[];
}

interface ApiKeyCreateResponse {
  api_key: string;
  api_key_id: string;
  key_prefix: string;
  key: ApiKeySummary;
  warning: string;
}

interface ApiKeyRenameResponse {
  ok: true;
  api_key_id: string;
  key: ApiKeySummary;
}

interface AccountsResponse {
  accounts: Array<{
    id: string;
    account_id: string;
    name: string;
    owner_user_id: string;
    role: string;
  }>;
  default_account_id: string;
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

interface AppResponse {
  app_id: string;
  account_id?: string | null;
  name: string;
  origin: string;
  production?: boolean;
}

interface UnpublishResponse {
  app_id: string;
  status: string;
  deleted_at: string;
}

interface RollbackResponse {
  app_id: string;
  release_id: string;
  previous_release_id: string | null;
  origin: string;
  status: string;
}

interface SecretsListResponse {
  app_id: string;
  secrets: Array<{
    name: string;
    created_at: string;
    updated_at: string;
  }>;
}

interface SecretDeleteResponse {
  name: string;
  present: boolean;
}

interface InviteResponse {
  invite_id: string;
  email: string;
  roles: string[];
  expires_at: string;
  invite_url: string;
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

interface AccountStatusResponse {
  account_id: string;
  plan_key?: string;
  billing_access_state: string;
  grace_ends_at: string | null;
  account_flags?: string[];
  active_flags?: string[];
  suspended?: boolean;
  restricted?: boolean;
  reasons?: string[];
  warnings?: Array<{ code?: string; message?: string }>;
  route_counts?: Record<string, number>;
  usage?: Record<string, number>;
  limits?: Record<string, number | null>;
}

interface AccountLimitsResponse {
  account_id: string;
  plan_key: string;
  features: Record<string, boolean>;
  manifest_limits: Record<string, unknown>;
  deployment_limits: Record<string, number | null>;
  runtime_limits: Record<string, number | null>;
  release_limits: Record<string, number | null>;
  usage_limits: Record<string, number | null>;
  usage: Record<string, number>;
  usage_period?: { period_start?: string; period_end?: string };
  route_counts?: Record<string, number>;
  compatibility_warnings?: Array<{ code?: string; message?: string }>;
}

interface DowngradePreviewResponse {
  account_id: string;
  current_plan_key: string;
  target_plan_key: string;
  compatible: boolean;
  violations: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
}

interface AppStatusResponse {
  app_id: string;
  account_id: string | null;
  billing_access_state?: string;
  account_flags?: string[];
  app_flags?: string[];
  suspended?: boolean;
  takedown?: boolean;
  can_serve_canonical?: boolean;
  can_mutate?: boolean;
  reasons?: string[];
  routes?: RouteRecord[];
  operational_state?: Record<string, unknown> | null;
}

interface RouteRecord {
  route_id: string;
  account_id?: string;
  app_id?: string;
  route_type: string;
  hostname: string;
  slug: string | null;
  status: string;
  reason: string | null;
  verification?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

interface RoutesResponse {
  app_id: string;
  routes: RouteRecord[];
}

interface RouteResponse {
  app_id: string;
  route: RouteRecord;
}

interface AnalyticsDimension {
  key: string;
  label: string;
  dimensions?: Record<string, unknown>;
  request_count: number;
  error_count: number;
  total_response_bytes?: number;
}

interface AppAnalyticsResponse {
  app_id: string;
  account_id?: string;
  range: { from: string; to: string; days: number };
  entitlement?: { enabled: boolean; plan_key?: string; retention_days?: number };
  traffic: {
    total_requests: number;
    successful_requests: number;
    error_requests: number;
    error_rate: number;
    total_response_bytes?: number;
    status_buckets?: Record<string, number>;
  };
  series?: Array<{ day: string; requests: number; errors: number }>;
  status_buckets?: AnalyticsDimension[];
  top_paths?: AnalyticsDimension[];
  top_referrers?: AnalyticsDimension[];
  routes?: AnalyticsDimension[];
  runtime_targets?: AnalyticsDimension[];
  auth?: { enabled: boolean; signups: number; sessions_created: number };
  jobs?: Record<string, number>;
  webhooks?: Record<string, number>;
  recent_errors?: Array<{
    app_event_id?: string;
    release_id?: string | null;
    type?: string;
    event_type?: string;
    severity?: string;
    level?: string;
    message: string;
    request_id?: string | null;
    created_at: string;
  }>;
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly body: unknown;

  constructor(message: string, status: number, code: string | undefined, details: unknown, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.body = body;
  }
}

const ANALYTICS_RANGES = ["7d", "30d", "90d"];
const FILE_SAFETY_ERROR_CODES = new Set(["unsafe_path", "symlink", "missing_file", "private_key"]);
// The API's rules for app secret names (packages/shared SECRET_NAME_PATTERN and its reserved prefixes).
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const RESERVED_SECRET_PREFIXES = ["USERLAND_", "CF_", "CLOUDFLARE_"];
const ANALYTICS_USAGE = "Usage: userland apps analytics <app-id> [--range 7d|30d|90d] [--account <account-id>] [--json]";
const APP_ANALYTICS_DOCS_URL = "https://docs.userland.fun/guides/app-analytics";
const UNPUBLISH_USAGE = "Usage: userland apps unpublish <app-id> [--yes] [--account <account-id>] [--json]";
const SECRETS_LIST_USAGE = "Usage: userland apps secrets list <app-id> [--account <account-id>] [--json]";
const SECRETS_DELETE_USAGE = "Usage: userland apps secrets delete <app-id> <NAME> [--yes] [--account <account-id>]";
const INVITES_CREATE_USAGE =
  "Usage: userland apps invites create <app-id> --email <email> [--role <role>]... [--expires-in-days <1-30>] [--account <account-id>] [--json]";
// The API's invite lifetime: 7 days unless expires_in_seconds asks for 1 second to 30 days.
const INVITE_MAX_DAYS = 30;
const SECONDS_PER_DAY = 60 * 60 * 24;

interface SupportRequestResponse {
  status: "sent";
  correlation_id: string;
  reply_to_email: string;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (isHelpCommand(command)) {
    usage(0);
  }

  if (isVersionCommand(command)) {
    console.log(CLI_VERSION);
    return;
  }

  if (command === "apps") {
    await appsCommand(args);
    return;
  }

  if (command === "auth") {
    await authCommand(args);
    return;
  }

  if (command === "api-keys") {
    await apiKeysCommand(args);
    return;
  }

  if (command === "accounts") {
    await accountsCommand(args);
    return;
  }

  if (command === "support") {
    await supportCommand(args);
    return;
  }

  if (command === "signup") {
    await signupCommand(args);
    return;
  }

  if (command === "login") {
    await loginCommand(args);
    return;
  }

  if (command === "publish") {
    await publishCommand(args);
    return;
  }

  if (command === "validate") {
    await validateCommand(args);
    return;
  }

  if (command === "analytics") {
    await analyticsCommand(args);
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
    await listAppsCommand(rest);
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
  if (subcommand === "unpublish") {
    await unpublishCommand(rest);
    return;
  }
  if (subcommand === "secrets" && rest[0] === "set") {
    await setSecretCommand(rest.slice(1));
    return;
  }
  if (subcommand === "secrets" && rest[0] === "list") {
    await listSecretsCommand(rest.slice(1));
    return;
  }
  if (subcommand === "secrets" && rest[0] === "delete") {
    await deleteSecretCommand(rest.slice(1));
    return;
  }
  if (subcommand === "invites" && rest[0] === "create") {
    await createInviteCommand(rest.slice(1));
    return;
  }
  if (subcommand === "events") {
    await eventsCommand(rest);
    return;
  }
  if (subcommand === "status") {
    await appStatusCommand(rest);
    return;
  }
  if (subcommand === "analytics") {
    await analyticsCommand(rest);
    return;
  }
  if (subcommand === "routes" && rest[0] === "list") {
    await routesListCommand(rest.slice(1));
    return;
  }
  if (subcommand === "slugs") {
    await appSlugsCommand(rest);
    return;
  }
  if (subcommand === "domains") {
    await appDomainsCommand(rest);
    return;
  }
  usage(1);
}

async function authCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "signup") {
    await signupCommand(rest);
    return;
  }
  if (subcommand === "login") {
    await loginCommand(rest);
    return;
  }
  if (subcommand === "status") {
    await authStatusCommand();
    return;
  }
  if (subcommand === "save-key") {
    await saveKeyCommand(rest);
    return;
  }
  if (subcommand === "logout") {
    await logoutCommand(rest);
    return;
  }
  if (subcommand === "api-keys") {
    await apiKeysCommand(rest);
    return;
  }
  usage(1);
}

async function apiKeysCommand(args: string[]): Promise<void> {
  const [subcommand, keyId, ...rest] = args;
  if (subcommand === "list") {
    await apiKeysListCommand();
    return;
  }
  if (subcommand === "create") {
    await apiKeysCreateCommand([keyId, ...rest].filter((value): value is string => value !== undefined));
    return;
  }
  if (subcommand === "rename" && keyId) {
    await apiKeysRenameCommand(keyId, rest);
    return;
  }
  if (subcommand === "revoke" && keyId) {
    await apiKeysRevokeCommand(keyId, rest);
    return;
  }
  usage(1);
}

async function accountsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    await listAccountsCommand();
    return;
  }
  if (subcommand === "use") {
    await useAccountCommand(rest);
    return;
  }
  if (subcommand === "status") {
    await accountStatusCommand(rest);
    return;
  }
  if (subcommand === "limits") {
    await accountLimitsCommand(rest);
    return;
  }
  if (subcommand === "downgrade" && rest[0] === "preview") {
    await downgradePreviewCommand(rest.slice(1));
    return;
  }
  usage(1);
}

async function supportCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "open") {
    await supportOpenCommand(rest);
    return;
  }
  usage(1);
}

async function signupCommand(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  await deviceLoginCommand(options, { signupAlias: true });
}

async function loginCommand(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  await deviceLoginCommand(options, { signupAlias: false });
}

async function deviceLoginCommand(options: AuthOptions, context: { signupAlias: boolean }): Promise<void> {
  if (options.save !== false) {
    // Stop on an unreadable credentials file now, not after the browser approval has created a key.
    await readCredentials();
  }
  // Log in to --api-base-url, USERLAND_API_BASE_URL, or the default API. A URL saved by an earlier
  // login is not reused, so one login against another API does not stick for later logins.
  const baseUrl = options.apiBaseUrl ?? envValue("USERLAND_API_BASE_URL") ?? DEFAULT_API_BASE_URL;
  assertServiceUrl(baseUrl, "API base URL");
  const start = await requestJson<DeviceStartResponse>(baseUrl, "/v0/auth/device/start", {
    method: "POST",
    body: JSON.stringify({
      client: "userland-cli",
      client_version: CLI_VERSION,
      requested_capability: "api_key"
    })
  });
  const verificationUrl = deviceVerificationUrl(start, baseUrl, options.consoleUrl);
  const consoleUrl = options.consoleUrl ?? new URL(verificationUrl).origin;

  if (context.signupAlias) {
    console.log("Signup uses the same browser approval flow as login. New accounts are created in the browser after email proof.");
  }
  if (options.email) {
    console.log(`email_hint=${terminalSafe(options.email)}`);
  }
  if (!options.noBrowser) {
    const opened = await openBrowser(verificationUrl);
    if (opened) {
      console.log("Opened your browser for Userland authorization.");
    }
  }
  console.log("Open this URL to sign in to Userland:");
  console.log("");
  console.log(verificationUrl);
  console.log("");
  console.log(`user_code=${terminalSafe(String(start.user_code))}`);
  console.log("Waiting for approval...");

  const response = terminalSafeValue(await pollDeviceAuthorization(baseUrl, start));

  if (options.save !== false) {
    // Approval can take minutes, and another login may save a key meanwhile. Revoke the key this save
    // actually overwrites, read right before the write, not the one saved when this login started.
    const { filePath, replaced } = await replaceCredentials({
      api_key: response.api_key,
      api_key_id: response.api_key_id ?? null,
      api_base_url: baseUrl,
      console_url: consoleUrl,
      username: response.username ?? null,
      account_id: response.default_account_id ?? null
    });
    console.log(`Saved API key to ${filePath}`);
    if (response.username) {
      console.log(`username=${response.username}`);
    }
    if (response.default_account_id) {
      console.log(`selected_account_id=${response.default_account_id}`);
    }
    await revokeReplacedLoginKey(replaced, { apiKey: response.api_key, apiKeyId: response.api_key_id, baseUrl });
    return;
  }

  console.log(`api_key=${response.api_key}`);
  if (response.api_key_id) {
    console.log(`api_key_id=${response.api_key_id}`);
  }
  if (response.default_account_id) {
    console.log(`selected_account_id=${response.default_account_id}`);
  }
}

/**
 * Each login creates a new API key. When it replaces a key an earlier login saved for the same API,
 * revoke the old one with the new key so the old key does not stay valid with no copy left. Keys saved
 * with `auth save-key` have no saved id and are left alone. A failed revoke does not fail the login.
 */
async function revokeReplacedLoginKey(previous: CredentialsFile | undefined, current: { apiKey: string; apiKeyId?: string; baseUrl: string }): Promise<void> {
  const previousKeyId = previous?.api_key_id;
  if (!previous?.api_key || !previousKeyId || previousKeyId === current.apiKeyId || previous.api_key === current.apiKey) {
    return;
  }
  if (!sameApi(previous.api_base_url ?? DEFAULT_API_BASE_URL, current.baseUrl)) {
    return;
  }
  try {
    await requestJson<ApiKeyRevokeResponse>(current.baseUrl, `/v0/auth/api-keys/${pathSegment(previousKeyId, "API key id")}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${current.apiKey}` }
    });
    console.log(`revoked_previous_api_key_id=${terminalSafe(previousKeyId)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(
      `warning=previous_api_key_not_revoked The API key from your previous login (${terminalSafe(previousKeyId)}) is still active: ${terminalSafe(message)}. Revoke it with: userland auth api-keys revoke ${terminalSafe(previousKeyId)}`
    );
  }
}

/**
 * The browser link for device login. The link from the API must be https (http only for localhost)
 * and, for the default API or a configured console, must be on the Userland console. Anything else is
 * refused before it is printed or opened.
 */
function deviceVerificationUrl(start: DeviceStartResponse, baseUrl: string, consoleUrlFlag: string | undefined): string {
  if (consoleUrlFlag !== undefined) {
    const consoleUrl = assertServiceUrl(consoleUrlFlag, "--console-url");
    return `${consoleUrl.href.replace(/\/$/u, "")}/device?code=${encodeURIComponent(String(start.user_code))}`;
  }
  const url = assertServiceUrl(typeof start.verification_uri_complete === "string" ? start.verification_uri_complete : "", "The sign-in link from the API");
  const configuredConsole = envValue("USERLAND_CONSOLE_URL");
  const expectedConsole = configuredConsole ?? (sameApi(baseUrl, DEFAULT_API_BASE_URL) ? DEFAULT_CONSOLE_BASE_URL : undefined);
  if (expectedConsole !== undefined) {
    const expectedOrigin = assertServiceUrl(expectedConsole, configuredConsole ? "USERLAND_CONSOLE_URL" : "Console URL").origin;
    if (url.origin !== expectedOrigin) {
      throw new Error(
        `The sign-in link from the API is on ${url.origin}, not the Userland console at ${expectedOrigin}, so the CLI did not open it. Check --api-base-url and USERLAND_API_BASE_URL, or pass --console-url.`
      );
    }
  }
  return url.href;
}

async function authStatusCommand(): Promise<void> {
  const credentials = await readCredentials();
  const filePath = credentialsPath();
  const target = apiTarget(credentials);
  const selectedAccountId = envValue("USERLAND_ACCOUNT_ID") ?? credentials?.account_id;
  const accountSource = envValue("USERLAND_ACCOUNT_ID") ? "env" : credentials?.account_id ? "file" : target.keySource === "missing" ? "missing" : "default";
  console.log(`api_base_url=${terminalSafe(target.baseUrl)}`);
  console.log(`console_url=${terminalSafe(envValue("USERLAND_CONSOLE_URL") ?? credentials?.console_url ?? DEFAULT_CONSOLE_BASE_URL)}`);
  console.log(`api_key=${target.keySource}`);
  console.log(`credentials_file=${filePath}`);
  if (target.keySource === "file" && credentials?.api_key_id) {
    console.log(`api_key_id=${terminalSafe(credentials.api_key_id)}`);
  }
  console.log(`account=${accountSource}`);
  if (selectedAccountId) {
    console.log(`account_id=${terminalSafe(selectedAccountId)}`);
  }
  if (target.keySource === "file" && credentials?.username) {
    console.log(`username=${terminalSafe(credentials.username)}`);
  }
  if (target.conflict) {
    console.log(`warning=api_base_url_mismatch ${target.conflict}`);
  }
}

async function saveKeyCommand(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  if (options.apiKey !== undefined) {
    console.error("warning=api_key_on_command_line A key passed with --api-key can be kept in shell history and seen by other programs on this computer. Pipe it on stdin instead: printf '%s' \"$USERLAND_API_KEY\" | userland auth save-key");
  }
  const apiKey = options.apiKey ?? (process.stdin.isTTY ? await promptHidden("API key: ") : (await readStdin()).trim());
  if (!apiKey) {
    throw new Error("API key is required. Pipe it on stdin (printf '%s' \"$USERLAND_API_KEY\" | userland auth save-key) or type it at the prompt.");
  }
  // The key is saved with the API it is for: --api-base-url, USERLAND_API_BASE_URL, or the default API.
  const baseUrl = options.apiBaseUrl ?? envValue("USERLAND_API_BASE_URL") ?? DEFAULT_API_BASE_URL;
  assertServiceUrl(baseUrl, "API base URL");
  const consoleUrl = options.consoleUrl ?? envValue("USERLAND_CONSOLE_URL") ?? (sameApi(baseUrl, DEFAULT_API_BASE_URL) ? DEFAULT_CONSOLE_BASE_URL : null);
  if (consoleUrl) {
    assertServiceUrl(consoleUrl, "Console URL");
  }
  const filePath = await saveCredentials({
    api_key: apiKey,
    api_key_id: null,
    api_base_url: baseUrl,
    console_url: consoleUrl,
    username: null,
    account_id: options.account ?? null
  });
  console.log(`Saved API key to ${filePath}`);
  if (options.account) {
    console.log(`selected_account_id=${terminalSafe(options.account)}`);
  }
}

async function logoutCommand(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  const credentials = await readCredentials();
  const filePath = credentialsPath();
  if (options.revoke) {
    if (credentials?.api_key && credentials.api_key_id) {
      // A saved key is only sent to the API it was saved for.
      const savedBaseUrl = credentials.api_base_url ?? DEFAULT_API_BASE_URL;
      const requested = options.apiBaseUrl ?? envValue("USERLAND_API_BASE_URL");
      if (requested !== undefined && !sameApi(requested, savedBaseUrl)) {
        throw new Error(`The saved API key belongs to ${savedBaseUrl}, not ${requested}. Run \`userland auth logout --revoke\` without --api-base-url or USERLAND_API_BASE_URL.`);
      }
      await requestJson<ApiKeyRevokeResponse>(
        savedBaseUrl,
        `/v0/auth/api-keys/${pathSegment(credentials.api_key_id, "API key id")}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${credentials.api_key}`
          }
        }
      );
      console.log(`revoked_api_key_id=${terminalSafe(credentials.api_key_id)}`);
    } else {
      console.log("revoke=skipped api_key_id_missing");
    }
  } else if (credentials?.api_key && credentials.api_key_id) {
    console.error(
      `note=api_key_still_active The saved API key ${terminalSafe(credentials.api_key_id)} was not revoked and still works. Revoke it in the Userland console, or next time use \`userland auth logout --revoke\` to revoke it as you sign out.`
    );
  }
  await fs.rm(filePath, { force: true });
  console.log("local_credentials=removed");
  console.log(`credentials_file=${filePath}`);
}

async function apiKeysListCommand(): Promise<void> {
  const response = await apiFetch<ApiKeyListResponse>("/v0/auth/api-keys", {
    method: "GET"
  });

  for (const key of response.api_keys) {
    console.log([
      key.api_key_id,
      key.revoked_at ? "revoked" : "active",
      key.created_at,
      key.last_used_at ?? "never",
      key.key_prefix,
      key.name ?? ""
    ].join("\t"));
  }
}

async function apiKeysCreateCommand(args: string[]): Promise<void> {
  const options = parseApiKeyOptions(args);
  if (!options.name) {
    throw new Error("--name is required.");
  }

  const response = await apiFetch<ApiKeyCreateResponse>("/v0/auth/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: options.name })
  });

  console.log(`Created API key ${response.api_key_id}`);
  console.log(`Name: ${response.key.name ?? ""}`);
  console.log(`Prefix: ${response.key_prefix}`);
  console.log("");
  console.log("API key:");
  console.log(response.api_key);
  console.log("");
  console.log(response.warning);
}

async function apiKeysRenameCommand(apiKeyId: string, args: string[]): Promise<void> {
  const options = parseApiKeyOptions(args);
  if (!options.name) {
    throw new Error("--name is required.");
  }

  const response = await apiFetch<ApiKeyRenameResponse>(`/v0/auth/api-keys/${pathSegment(apiKeyId, "API key id")}`, {
    method: "PATCH",
    body: JSON.stringify({ name: options.name })
  });

  console.log(`Renamed API key ${response.api_key_id}`);
  console.log(`Name: ${response.key.name ?? ""}`);
}

async function apiKeysRevokeCommand(apiKeyId: string, args: string[]): Promise<void> {
  const options = parseApiKeyOptions(args);
  const keyPath = `/v0/auth/api-keys/${pathSegment(apiKeyId, "API key id")}`;
  const credentials = await readCredentials();
  if (credentials?.api_key_id === apiKeyId) {
    console.log("This is the API key saved for the current CLI credentials. Subsequent saved-credential commands may fail.");
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new Error("Pass --yes to revoke an API key non-interactively.");
    }
    const answer = await promptLine(`Revoke API key ${apiKeyId}? Type yes to continue: `);
    if (answer.toLowerCase() !== "yes") {
      console.log("revocation=cancelled");
      return;
    }
  }

  const response = await apiFetch<ApiKeyRevokeResponse>(keyPath, {
    method: "DELETE"
  });
  if (response.revoked) {
    console.log(`Revoked API key ${response.api_key_id}`);
  } else {
    console.log(`API key ${response.api_key_id} was already revoked.`);
  }
}

async function listAccountsCommand(): Promise<void> {
  const response = await apiFetch<AccountsResponse>("/v0/accounts", {
    method: "GET"
  });

  for (const account of response.accounts) {
    console.log(`${account.account_id}\t${account.role}\t${account.name}`);
  }
  console.log(`default_account_id=${response.default_account_id}`);
}

async function useAccountCommand(args: string[]): Promise<void> {
  const accountId = args[0];
  if (!accountId) {
    usage(1);
  }
  const filePath = await saveCredentials({ account_id: accountId });
  console.log(`selected_account_id=${accountId}`);
  console.log(`credentials_file=${filePath}`);
}

async function accountStatusCommand(args: string[]): Promise<void> {
  const options = parseAccountOptions(args);
  const accountId = await resolveAccountId(options.account);
  const response = await apiFetch<AccountStatusResponse>(`/v0/accounts/${pathSegment(accountId, "account id")}/status`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });

  console.log(`account_id=${response.account_id}`);
  if (response.plan_key) console.log(`plan_key=${response.plan_key}`);
  console.log(`billing_access_state=${response.billing_access_state}`);
  console.log(`grace_ends_at=${response.grace_ends_at ?? ""}`);
  if (response.suspended !== undefined) console.log(`suspended=${response.suspended}`);
  if (response.restricted !== undefined) console.log(`restricted=${response.restricted}`);
  printList("account_flags", response.account_flags ?? response.active_flags);
  printList("reasons", response.reasons);
  printWarnings(response.warnings);
}

async function accountLimitsCommand(args: string[]): Promise<void> {
  const options = parseAccountOptions(args);
  const accountId = await resolveAccountId(options.account);
  const response = await apiFetch<AccountLimitsResponse>(`/v0/accounts/${pathSegment(accountId, "account id")}/limits`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });

  console.log(`account_id=${response.account_id}`);
  console.log(`plan_key=${response.plan_key}`);
  if (response.usage_period?.period_start) console.log(`usage_period_start=${response.usage_period.period_start}`);
  if (response.usage_period?.period_end) console.log(`usage_period_end=${response.usage_period.period_end}`);
  printKeyValues("feature", response.features);
  printKeyValues("manifest_limit", response.manifest_limits);
  printKeyValues("deployment_limit", response.deployment_limits);
  printKeyValues("runtime_limit", response.runtime_limits);
  printKeyValues("release_limit", response.release_limits);
  printKeyValues("usage_limit", response.usage_limits);
  printKeyValues("usage", response.usage);
  if (response.route_counts) printKeyValues("route_count", response.route_counts);
  printWarnings(response.compatibility_warnings);
}

async function downgradePreviewCommand(args: string[]): Promise<void> {
  const options = parseDowngradePreviewOptions(args);
  if (!options.to) {
    usage(1);
  }
  // Only self-serve plans (and their older aliases) are valid targets; any other plan key is a usage error.
  const targetPlanKey = requirePlanKey(options.to);
  const accountId = await resolveAccountId(options.account);
  const params = new URLSearchParams({ plan: targetPlanKey });
  const response = await apiFetch<DowngradePreviewResponse>(`/v0/accounts/${pathSegment(accountId, "account id")}/downgrade-preview?${params.toString()}`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });

  console.log(`account_id=${response.account_id}`);
  console.log(`current_plan_key=${response.current_plan_key}`);
  console.log(`target_plan_key=${response.target_plan_key}`);
  console.log(`compatible=${response.compatible}`);
  for (const violation of response.violations) {
    console.log(`violation=${formatFields(violation)}`);
  }
  for (const action of response.actions) {
    console.log(`action=${formatFields(action)}`);
  }
}

async function supportOpenCommand(args: string[]): Promise<void> {
  const options = parseSupportOptions(args);
  const subject = options.subject?.trim();
  if (!subject) {
    throw new Error("--subject is required.");
  }
  const message = (options.message ?? (await readStdin())).trim();
  if (!message) {
    throw new Error("--message is required or provide message on stdin.");
  }

  const body: Record<string, string> = {
    subject,
    message
  };
  if (options.app) {
    body.app_id = options.app;
  }

  const response = await apiFetch<SupportRequestResponse>("/v0/support/requests", {
    method: "POST",
    body: JSON.stringify(body)
  }, { accountId: options.account, accountScoped: true, raw: options.json === true });

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log("Support request sent.");
  console.log(`correlation_id=${response.correlation_id}`);
  console.log(`reply_to_email=${response.reply_to_email}`);
}

async function validateCommand(args: string[]): Promise<void> {
  const dir = args[0];
  if (!dir || dir.startsWith("--")) {
    usage(1);
  }
  const options = parseValidateOptions(args.slice(1));
  const planKey = options.plan === undefined ? undefined : requirePlanKey(options.plan);
  const report = await validateAppDirectory(dir, { planKey, planSource: "flag", strict: options.strict });

  if (options.json) {
    console.log(JSON.stringify(validationJson(report), null, 2));
  } else {
    process.stdout.write(formatValidationReport(report, { dir }));
  }
  process.exitCode = validationExitCode(report);
}

function requirePlanKey(value: string): string {
  const planKey = normalizePlanKey(value);
  if (!planKey) {
    throw new Error(`Unknown plan: ${value}. Use one of: ${publicPlanKeys().join(", ")}.`);
  }
  return planKey;
}

async function publishCommand(args: string[]): Promise<void> {
  const dir = args[0];
  const options = parseOptions(args.slice(1));
  if (!dir) {
    usage(1);
  }
  // Checked before anything else: an --app of "." or ".." would otherwise publish a new app.
  const publishPath = options.app !== undefined ? `/v0/apps/${pathSegment(options.app, "app id")}` : "/v0/apps";

  if (options.skipLocalValidation) {
    console.log("local_validation=skipped");
  } else if (!(await publishPreflight(dir, options))) {
    return;
  }

  const body = await readPublishDirectory(dir, options);
  const response = await apiFetch<PublishResponse>(publishPath, {
    method: "PUT",
    body: JSON.stringify(body)
  }, { accountId: options.account, accountScoped: true });

  console.log(`Published ${response.origin}`);
  console.log(`app_id=${response.app_id}`);
  console.log(`release_id=${response.release_id}`);
  console.log(`previous_release_id=${response.previous_release_id ?? ""}`);
  console.log(`activation_status=${response.activation.status}`);
  if (response.activation.reasons.length > 0) {
    console.log(`activation_reasons=${response.activation.reasons.join("; ")}`);
  }
}

/**
 * Runs local validation before uploading. Manifest and file errors block without any
 * network call. Plan checks use --plan, otherwise the account's effective entitlements
 * from GET /v0/accounts/:account_id/limits; when that lookup fails the API decides.
 * Returns false when the publish is blocked.
 */
async function publishPreflight(dir: string, options: CliOptions): Promise<boolean> {
  const analysis = await analyzeAppDirectory(dir);
  const structural = analysis.report;
  if (structural.errors.length > 0) {
    printPublishBlocked(structural, dir);
    return false;
  }

  let planKey: string | undefined;
  let planSource: "flag" | "account" | undefined;
  let entitlements: EntitlementConfig | undefined;
  if (options.plan !== undefined) {
    planKey = requirePlanKey(options.plan);
    planSource = "flag";
  } else {
    const account = await fetchAccountEntitlements(options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("USERLAND_API_KEY")) {
        throw error;
      }
      console.error(`warning=plan_lookup_failed ${terminalSafe(message.split("\n")[0])}`);
      return undefined;
    });
    if (account) {
      planKey = account.planKey;
      planSource = "account";
      entitlements = account.config;
    }
  }

  if (!planKey) {
    for (const warning of structural.warnings) {
      console.error(formatWarning(warning));
    }
    if (structural.required_plan_key !== null && !isSelfServePlan(structural.required_plan_key)) {
      console.error("warning=plan_check_skipped This app uses features that are not available on self-serve plans; the API will check your account plan. Contact support if you need them.");
    } else if (structural.required_plan_key !== null && structural.required_plan_key !== "free") {
      console.error(`warning=plan_check_skipped This app needs the ${planDisplayName(structural.required_plan_key)} plan or higher; the API will check your account plan.`);
    }
    console.log("local_validation=passed_without_plan");
    return true;
  }

  const report = applyPlan(analysis, { planKey, planSource, entitlements });
  if (!report.ok) {
    printPublishBlocked(report, dir);
    return false;
  }
  for (const warning of report.warnings) {
    console.error(formatWarning(warning));
  }
  console.log("local_validation=passed");
  console.log(`local_validation_plan=${planKey}`);
  console.log(`local_validation_plan_source=${planSource}`);
  return true;
}

async function fetchAccountEntitlements(options: CliOptions): Promise<{ planKey: string; config: EntitlementConfig }> {
  let accountId: string | undefined;
  if (options.app) {
    const app = await apiFetch<AppStatusResponse>(`/v0/apps/${pathSegment(options.app, "app id")}`, {
      method: "GET"
    }, { accountId: options.account, accountScoped: true });
    accountId = app.account_id ?? undefined;
  }
  accountId ??= await resolveAccountId(options.account);
  const limits = await apiFetch<AccountLimitsResponse>(`/v0/accounts/${pathSegment(accountId, "account id")}/limits`, {
    method: "GET"
  }, { accountId, accountScoped: true });
  if (typeof limits.plan_key !== "string" || !isPlainObject(limits.features) || !isPlainObject(limits.manifest_limits)) {
    throw new Error("Account limits response is missing plan features.");
  }
  return {
    planKey: limits.plan_key,
    config: {
      features: limits.features,
      manifest_limits: limits.manifest_limits as Record<string, ManifestLimitValue>,
      release_limits: limits.release_limits
    }
  };
}

function printPublishBlocked(report: ValidationReport, dir: string): void {
  console.error("Local validation blocked this publish; nothing was uploaded.");
  process.stderr.write(formatValidationReport(report, { dir }));
  // Unsafe paths, symlinks, missing files, and private keys are never uploaded, even without local validation.
  if (!report.errors.some((error) => FILE_SAFETY_ERROR_CODES.has(error.code))) {
    console.error(`To send it to the API anyway (the API still enforces these rules): userland apps publish ${dir} --skip-local-validation`);
  }
  process.exitCode = validationExitCode(report) || 1;
}

async function analyticsCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (!appId || appId.startsWith("--")) {
    console.error(ANALYTICS_USAGE);
    process.exit(1);
  }
  const options = parseAnalyticsOptions(args.slice(1));
  if (options.range !== undefined && !ANALYTICS_RANGES.includes(options.range)) {
    console.error(`Invalid --range value: ${options.range || "(missing)"}. Use 7d, 30d, or 90d.`);
    console.error(ANALYTICS_USAGE);
    process.exit(1);
  }

  const suffix = options.range ? `?${new URLSearchParams({ range: options.range }).toString()}` : "";
  let response: AppAnalyticsResponse;
  try {
    response = await apiFetch<AppAnalyticsResponse>(`/v0/apps/${pathSegment(appId, "app id")}/analytics${suffix}`, {
      method: "GET"
    }, { accountId: options.account, accountScoped: true, raw: options.json === true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 402 && error.code === "entitlement_required") {
      printAnalyticsUpgradeState(appId, error, options.json === true);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  printAnalytics(response, options.range);
}

function printAnalyticsUpgradeState(appId: string, error: ApiError, json: boolean): void {
  const details = isPlainObject(error.details) ? error.details : {};
  const planKey = stringValue(details.plan_key);
  const requiredPlanKey = stringValue(details.required_plan_key);
  const shown = (value: string | undefined) => (value === undefined ? undefined : terminalSafe(value));
  if (json) {
    console.log(JSON.stringify({
      app_id: appId,
      entitlement: {
        enabled: false,
        plan_key: planKey ?? null,
        required_plan_key: requiredPlanKey ?? null
      },
      error: isPlainObject(error.body) ? error.body.error : { code: error.code },
      docs: APP_ANALYTICS_DOCS_URL
    }, null, 2));
  }
  console.error("App Analytics is not included in this account's plan.");
  console.error(`error=${shown(error.code)}`);
  console.error("feature=app_analytics");
  if (planKey) console.error(`plan_key=${shown(planKey)}`);
  if (requiredPlanKey) console.error(`required_plan_key=${shown(requiredPlanKey)}`);
  if (requiredPlanKey && !isSelfServePlan(requiredPlanKey)) {
    console.error("App Analytics is not available on self-serve plans for this account; contact support. Publishing and other app commands keep working.");
  } else {
    console.error(`Upgrade to ${requiredPlanKey ? terminalSafe(planDisplayName(requiredPlanKey)) : "a paid plan"} or higher to read traffic and error summaries for this app. Publishing and other app commands keep working.`);
  }
  console.error(`Docs: ${APP_ANALYTICS_DOCS_URL}`);
}

function printAnalytics(response: AppAnalyticsResponse, requestedRange: string | undefined): void {
  const traffic = response.traffic;
  console.log(`app_id=${response.app_id}`);
  console.log(`range=${response.range.days}d`);
  if (response.entitlement?.retention_days !== undefined) console.log(`retention_days=${response.entitlement.retention_days}`);
  console.log(`total_requests=${traffic.total_requests}`);
  console.log(`successful_requests=${traffic.successful_requests}`);
  console.log(`error_requests=${traffic.error_requests}`);
  console.log(`error_rate=${Number(traffic.error_rate.toFixed(4))}`);
  if (requestedRange && Number.parseInt(requestedRange, 10) > response.range.days) {
    console.log(`note=range clamped from ${requestedRange} to ${response.range.days}d by the plan retention window`);
  }

  if (traffic.total_requests === 0) {
    console.log("");
    console.log("No traffic recorded in this range yet. Analytics appear after the app serves eligible app-owned requests; health checks, /_userland/* routes, and unresolved hosts are not counted.");
  }

  const statusRows = Object.entries(traffic.status_buckets ?? {})
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  printAnalyticsTable("status", statusRows);
  printAnalyticsTable("top_paths", (response.top_paths ?? []).map((row) => [analyticsLabel(row.label), row.request_count]));
  printAnalyticsTable("top_referrers", (response.top_referrers ?? []).map((row) => [analyticsLabel(row.label), row.request_count]));
  if (response.auth?.enabled) {
    printAnalyticsTable("auth", [["signups", response.auth.signups], ["sessions_created", response.auth.sessions_created]]);
  }
  printAnalyticsTable("jobs", Object.entries(response.jobs ?? {}).filter(([, count]) => count > 0));
  printAnalyticsTable("webhooks", Object.entries(response.webhooks ?? {}).filter(([, count]) => count > 0));

  const errors = response.recent_errors ?? [];
  if (errors.length > 0) {
    console.log("");
    console.log("recent_errors:");
    for (const event of errors) {
      console.log([event.created_at, event.severity ?? event.level ?? "error", event.type ?? event.event_type ?? "", event.message].join(" "));
    }
  }
}

/** Shows API buckets such as __direct__ or __long__ as (direct) or (long). */
function analyticsLabel(label: string): string {
  return label.replace(/^__([a-z_]+)__$/u, "($1)");
}

function printAnalyticsTable(label: string, rows: Array<[string, number]>): void {
  if (rows.length === 0) {
    return;
  }
  const width = Math.max(...rows.map(([name]) => name.length)) + 2;
  console.log("");
  console.log(`${label}:`);
  for (const [name, count] of rows) {
    console.log(`${name.padEnd(width)}${count}`);
  }
}

async function listAppsCommand(args: string[] = []): Promise<void> {
  const options = parseAccountOptions(args);
  const response = await apiFetch<AppsResponse>("/v0/apps", {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });

  for (const app of response.apps) {
    console.log(`${app.app_id}\t${app.live_release_id ?? ""}\t${app.updated_at}\t${app.name}\t${app.origin}`);
  }
}

async function releasesCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (!appId) {
    usage(1);
  }
  const options = parseAccountOptions(args.slice(1));

  const response = await apiFetch<VersionResponse>(`/v0/apps/${pathSegment(appId, "app id")}/releases`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });

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
  const options = parseAccountOptions(args.slice(2));

  let response: RollbackResponse;
  try {
    response = await apiFetch<RollbackResponse>(`/v0/apps/${pathSegment(appId, "app id")}/rollback`, {
      method: "POST",
      body: JSON.stringify({ release_id: releaseId })
    }, { accountId: options.account, accountScoped: true });
  } catch (error) {
    throw withRollbackOutcome(error, appId);
  }

  console.log(`Rolled back ${response.origin}`);
  console.log(`app_id=${response.app_id}`);
  console.log(`release_id=${response.release_id}`);
  console.log(`previous_release_id=${response.previous_release_id ?? ""}`);
  console.log(`status=${response.status}`);
}

/**
 * DELETE /v0/apps/:app_id. The API takes the app offline, removes its slugs and custom domains, and
 * marks it deleted; its release history is kept. In a terminal the CLI first shows the app's name,
 * address, and account and asks for the app id or y. Without a terminal it needs --yes and sends
 * nothing otherwise.
 *
 * The API finds the app by id alone and ignores the selected account, so when an account is selected
 * (--account, USERLAND_ACCOUNT_ID, or the saved account) the CLI reads the app first, even with --yes,
 * and stops before the DELETE when the app belongs to a different account.
 */
async function unpublishCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (appId === undefined || appId.startsWith("-")) {
    console.error(UNPUBLISH_USAGE);
    process.exit(1);
  }
  const options = parseUnpublishOptions(args.slice(1));
  // Checked before anything is sent, like every other app command.
  const appPath = `/v0/apps/${pathSegment(appId, "app id")}`;
  if (!options.yes && !process.stdin.isTTY) {
    console.error("Unpublishing takes the app offline and removes its slugs and custom domains.");
    console.error(
      `There is no terminal to confirm in, so check with the app's owner first, then run: userland apps unpublish ${terminalSafe(appId)} --yes`
    );
    console.error(UNPUBLISH_USAGE);
    process.exit(1);
  }

  const accountId = selectedAccountId(options.account, await readCredentials());
  let app: AppResponse | undefined;
  if (!options.yes || accountId) {
    app = await readAppInSelectedAccount(appId, accountId, "Nothing was unpublished.");
    if (!options.yes && !(await confirmUnpublish(appId, app))) {
      console.error(`Cancelled. ${terminalSafe(appId)} was not unpublished.`);
      process.exitCode = 1;
      return;
    }
  }

  const response = await apiFetch<UnpublishResponse>(appPath, {
    method: "DELETE"
  }, { accountId, accountScoped: true, raw: options.json === true });

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  console.log(app?.origin ? `Unpublished ${app.name ? `${app.name} ` : ""}(${app.origin})` : `Unpublished ${response.app_id}`);
  console.log(`app_id=${response.app_id}`);
  console.log(`status=${response.status}`);
  console.log(`deleted_at=${response.deleted_at}`);
  console.log("The app is offline and its slugs and custom domains are removed. Its release history is kept.");
}

/** Shows what will be unpublished on stderr (stdout stays clean for --json) and reads the answer. */
async function confirmUnpublish(appId: string, app: AppResponse): Promise<boolean> {
  console.error("You are about to unpublish this app:");
  console.error(`  Name:        ${app.name || "(no name)"}`);
  console.error(`  Address:     ${app.origin ?? ""}`);
  console.error(`  App id:      ${app.app_id ?? terminalSafe(appId)}`);
  console.error(`  Account:     ${app.account_id || "(none)"}`);
  console.error(`  Production:  ${app.production === true ? "yes" : "no"}`);
  console.error("Unpublishing takes the app offline and removes its slugs and custom domains. Its release history is kept.");
  const answer = await promptLine(`Type the app id (${terminalSafe(appId)}) or y to unpublish it: `, process.stderr);
  return answer === appId || answer === app.app_id || ["y", "yes"].includes(answer.toLowerCase());
}

/**
 * Reads the app (GET /v0/apps/:app_id) before a change. The API finds an app by its id alone and
 * ignores the selected account, so when an account is selected (--account, USERLAND_ACCOUNT_ID, or the
 * saved account) and the app belongs to a different one, this stops with exit code 1 before anything
 * changes; `nothingDone` says what did not happen. Returns the app with API text safe to print.
 */
async function readAppInSelectedAccount(appId: string, accountId: string | undefined, nothingDone: string): Promise<AppResponse> {
  // Read as sent so the account check compares the real ids; `app` is the copy safe to print.
  const rawApp = await apiFetch<AppResponse>(`/v0/apps/${pathSegment(appId, "app id")}`, {
    method: "GET"
  }, { accountId, accountScoped: true, raw: true });
  const app = terminalSafeValue(rawApp);
  if (accountId && rawApp.account_id && rawApp.account_id !== accountId) {
    console.error(`${terminalSafe(appId)} belongs to account ${app.account_id}, not ${terminalSafe(accountId)}. ${nothingDone}`);
    console.error(`Check the app id with \`userland apps list\`. If you meant the other account, pass --account ${app.account_id}.`);
    process.exit(1);
  }
  return app;
}

/**
 * Checks a secret name against the API's rules before it goes into a request path: capital letters,
 * numbers, and underscores, starting with a letter, at most 64 characters, and not starting with a
 * prefix Userland keeps for itself.
 */
function assertSecretName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid secret name: ${name}. Secret names use capital letters, numbers, and underscores, start with a letter, and are at most 64 characters (for example MODEL_API_KEY).`);
  }
  if (RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new Error(`Invalid secret name: ${name}. Secret names cannot start with USERLAND_, CF_, or CLOUDFLARE_, which are kept for Userland.`);
  }
}

async function setSecretCommand(args: string[]): Promise<void> {
  const [appId, name, ...optionArgs] = args;
  if (!appId || !name) {
    usage(1);
  }
  const options = parseSecretSetOptions(optionArgs);
  assertSecretName(name);
  const secretPath = `/v0/apps/${pathSegment(appId, "app id")}/secrets/${pathSegment(name, "secret name")}`;
  if (options.value !== undefined) {
    console.error(`warning=secret_on_command_line A value passed with --value can be kept in shell history and seen by other programs on this computer. Pipe it on stdin instead: printf '%s' "$VALUE" | userland apps secrets set ${appId} ${name}`);
  }
  const value = options.value ?? (await readStdin()).trimEnd();
  if (!value) {
    throw new Error("Secret value is required on stdin, for example: printf '%s' \"$VALUE\" | userland apps secrets set <app-id> <NAME>");
  }

  const response = await apiFetch<{ name: string; present: boolean; updated_at: string }>(secretPath, {
    method: "PUT",
    body: JSON.stringify({ value })
  }, { accountId: options.account, accountScoped: true });

  console.log(`secret=${response.name}`);
  console.log(`present=${response.present}`);
  console.log(`updated_at=${response.updated_at}`);
}

/**
 * GET /v0/apps/:app_id/secrets. Prints the names of the secrets that are set and when each was first
 * and last set. The API never returns values, and the CLI prints only the name and the two dates, in
 * human output and in --json, so a value could not show up here even if a response carried one.
 */
async function listSecretsCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (appId === undefined || appId.startsWith("-")) {
    console.error(SECRETS_LIST_USAGE);
    process.exit(1);
  }
  const options = parseSecretsListOptions(args.slice(1));
  const response = await apiFetch<SecretsListResponse>(`/v0/apps/${pathSegment(appId, "app id")}/secrets`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true, raw: options.json === true });
  const secrets = (Array.isArray(response.secrets) ? response.secrets : []).map((secret) => ({
    name: secret.name,
    created_at: secret.created_at,
    updated_at: secret.updated_at
  }));

  if (options.json) {
    console.log(JSON.stringify({ app_id: response.app_id, secrets }, null, 2));
    return;
  }
  for (const secret of secrets) {
    console.log(`${secret.name}\t${secret.created_at}\t${secret.updated_at}`);
  }
  if (secrets.length === 0) {
    // On stderr, so a script reading stdout sees an empty list.
    console.error(`No secrets are set for ${terminalSafe(appId)}.`);
  }
}

/**
 * DELETE /v0/apps/:app_id/secrets/:NAME. The API removes the value at once, and answers the same
 * whether or not the secret was set, so the CLI first checks the name is set (a typo then deletes
 * nothing and says so, instead of reporting success). In a terminal it shows the secret and the app
 * and asks for the name or y; without a terminal it needs --yes and sends nothing otherwise. When an
 * account is selected, a secret in an app of a different account is not deleted (see
 * readAppInSelectedAccount).
 */
async function deleteSecretCommand(args: string[]): Promise<void> {
  const [appId, name] = args;
  if (appId === undefined || appId.startsWith("-") || name === undefined || name.startsWith("-")) {
    console.error(SECRETS_DELETE_USAGE);
    process.exit(1);
  }
  const options = parseSecretDeleteOptions(args.slice(2));
  // Checked before anything is sent, like every other app command.
  assertSecretName(name);
  const appSegment = pathSegment(appId, "app id");
  const secretPath = `/v0/apps/${appSegment}/secrets/${pathSegment(name, "secret name")}`;
  if (!options.yes && !process.stdin.isTTY) {
    console.error("Deleting a secret removes its value from the app at once. It cannot be brought back, only set again.");
    console.error(
      `There is no terminal to confirm in, so check with the app's owner first, then run: userland apps secrets delete ${terminalSafe(appId)} ${name} --yes`
    );
    console.error(SECRETS_DELETE_USAGE);
    process.exit(1);
  }

  const accountId = selectedAccountId(options.account, await readCredentials());
  let app: AppResponse | undefined;
  if (!options.yes || accountId) {
    app = await readAppInSelectedAccount(appId, accountId, "Nothing was deleted.");
  }
  const list = await apiFetch<SecretsListResponse>(`/v0/apps/${appSegment}/secrets`, {
    method: "GET"
  }, { accountId, accountScoped: true });
  const secret = (Array.isArray(list.secrets) ? list.secrets : []).find((entry) => entry.name === name);
  if (!secret) {
    throw new Error(
      `No secret named ${name} is set for ${appId}, so nothing was deleted. See the names that are set with: userland apps secrets list ${appId}`
    );
  }
  if (app && !options.yes && !(await confirmSecretDelete(appId, name, secret.updated_at, app))) {
    console.error(`Cancelled. ${name} was not deleted.`);
    process.exitCode = 1;
    return;
  }

  const response = await apiFetch<SecretDeleteResponse>(secretPath, {
    method: "DELETE"
  }, { accountId, accountScoped: true });

  console.log(`Deleted secret ${response.name} from ${terminalSafe(appId)}.`);
  console.log(`secret=${response.name}`);
  console.log(`present=${response.present}`);
  console.log(
    `Server code that reads ${response.name} no longer gets it. If manifest.userland.json lists it under resources.secrets.required, remove it there too, or the next release you publish waits (pending_secrets) until it is set again.`
  );
}

/** Shows what will be deleted on stderr and reads the answer: the secret's name or y. */
async function confirmSecretDelete(appId: string, name: string, updatedAt: string, app: AppResponse): Promise<boolean> {
  console.error("You are about to delete this secret:");
  console.error(`  Secret:      ${name}`);
  console.error(`  Last set:    ${updatedAt}`);
  console.error(`  App:         ${app.name || "(no name)"}`);
  console.error(`  Address:     ${app.origin ?? ""}`);
  console.error(`  App id:      ${app.app_id ?? terminalSafe(appId)}`);
  console.error(`  Account:     ${app.account_id || "(none)"}`);
  console.error(`Server code that reads ${name} stops getting it at once. The value cannot be shown or brought back; you can only set a new one.`);
  const answer = await promptLine(`Type the secret name (${name}) or y to delete it: `, process.stderr);
  return answer === name || ["y", "yes"].includes(answer.toLowerCase());
}

/**
 * POST /v0/apps/:app_id/admin-invites. Makes a sign-in invite for one person to use the app (an app
 * user, not a member of the Userland account) and prints only the invite link, which is all the
 * person needs. Works with the key saved by `userland login` as well as USERLAND_API_KEY.
 */
async function createInviteCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (appId === undefined || appId.startsWith("-")) {
    console.error(INVITES_CREATE_USAGE);
    process.exit(1);
  }
  const options = parseInviteCreateOptions(args.slice(1));
  if (options.email === undefined) {
    console.error("--email is required: the email address of the person to invite.");
    console.error(INVITES_CREATE_USAGE);
    process.exit(1);
  }
  const body: { email: string; roles: string[]; expires_in_seconds?: number } = {
    email: options.email.trim(),
    // Each role once, in the order given. No --role means no special role.
    roles: [...new Set(options.roles)]
  };
  if (options.expiresInDays !== undefined) {
    body.expires_in_seconds = inviteDays(options.expiresInDays) * SECONDS_PER_DAY;
  }
  const invitePath = `/v0/apps/${pathSegment(appId, "app id")}/admin-invites`;

  const response = await apiFetch<InviteResponse>(invitePath, {
    method: "POST",
    body: JSON.stringify(body)
  }, { accountId: options.account, accountScoped: true, raw: options.json === true });

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  console.log(response.invite_url);
}

/** --expires-in-days: a whole number of days from 1 to 30, the most the API allows. */
function inviteDays(value: string): number {
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > INVITE_MAX_DAYS) {
    console.error(`--expires-in-days must be a whole number of days from 1 to ${INVITE_MAX_DAYS}, not ${terminalSafe(value)}. Without it the link lasts 7 days.`);
    console.error(INVITES_CREATE_USAGE);
    process.exit(1);
  }
  return Number(value);
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
  if (options.cursor) params.set("cursor", options.cursor);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await apiFetch<EventsResponse>(`/v0/apps/${pathSegment(appId, "app id")}/events${suffix}`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });

  for (const event of response.events) {
    console.log(`${event.created_at}\t${event.severity}\t${event.type}\t${event.release_id ?? ""}\t${event.message}`);
  }
  if (response.cursor) {
    console.log(`cursor=${response.cursor}`);
  }
}

async function appStatusCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (!appId) {
    usage(1);
  }
  const options = parseAccountOptions(args.slice(1));
  const response = await apiFetch<AppStatusResponse>(`/v0/apps/${pathSegment(appId, "app id")}`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });
  const state = objectValue((response as unknown as Record<string, unknown>).operational_state) ?? {};

  console.log(`app_id=${response.app_id}`);
  if (response.account_id) console.log(`account_id=${response.account_id}`);
  if (stringValue(state.billing_access_state) ?? response.billing_access_state) console.log(`billing_access_state=${stringValue(state.billing_access_state) ?? response.billing_access_state}`);
  printOptionalBoolean("suspended", state.suspended ?? response.suspended);
  printOptionalBoolean("takedown", state.takedown ?? response.takedown);
  printOptionalBoolean("restricted", state.restricted);
  printOptionalBoolean("can_serve_canonical", state.can_serve_canonical ?? response.can_serve_canonical);
  printOptionalBoolean("can_mutate", state.can_mutate ?? response.can_mutate);
  printList("account_flags", stringArrayValue(state.account_flags) ?? response.account_flags);
  printList("app_flags", stringArrayValue(state.app_flags) ?? response.app_flags);
  printList("reasons", stringArrayValue(state.reasons) ?? response.reasons);
  if (response.routes) {
    for (const route of response.routes) {
      printRoute(route);
    }
  }
}

async function routesListCommand(args: string[]): Promise<void> {
  const appId = args[0];
  if (!appId) {
    usage(1);
  }
  const options = parseAccountOptions(args.slice(1));
  const response = await apiFetch<RoutesResponse>(`/v0/apps/${pathSegment(appId, "app id")}/routes`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });
  printRoutes(response.routes);
}

async function appSlugsCommand(args: string[]): Promise<void> {
  const [action, appId, slug, ...optionArgs] = args;
  if (action === "list" && appId) {
    const options = parseAccountOptions([slug, ...optionArgs].filter((value): value is string => value !== undefined));
    const response = await apiFetch<RoutesResponse>(`/v0/apps/${pathSegment(appId, "app id")}/slugs`, {
      method: "GET"
    }, { accountId: options.account, accountScoped: true });
    printRoutes(response.routes);
    return;
  }
  if (action === "add" && appId && slug) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${pathSegment(appId, "app id")}/slugs`, {
      method: "POST",
      body: JSON.stringify({ slug })
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  if (action === "remove" && appId && slug) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${pathSegment(appId, "app id")}/slugs/${pathSegment(slug, "slug")}`, {
      method: "DELETE"
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  usage(1);
}

async function appDomainsCommand(args: string[]): Promise<void> {
  const [action, appId, hostname, ...optionArgs] = args;
  if (action === "list" && appId) {
    const options = parseAccountOptions([hostname, ...optionArgs].filter((value): value is string => value !== undefined));
    const response = await apiFetch<RoutesResponse>(`/v0/apps/${pathSegment(appId, "app id")}/domains`, {
      method: "GET"
    }, { accountId: options.account, accountScoped: true });
    printRoutes(response.routes);
    return;
  }
  if (action === "add" && appId && hostname) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${pathSegment(appId, "app id")}/domains`, {
      method: "POST",
      body: JSON.stringify({ hostname })
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  if (action === "verify" && appId && hostname) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${pathSegment(appId, "app id")}/domains/${pathSegment(hostname, "domain")}/verify`, {
      method: "POST",
      body: JSON.stringify({})
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  if (action === "remove" && appId && hostname) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${pathSegment(appId, "app id")}/domains/${pathSegment(hostname, "domain")}`, {
      method: "DELETE"
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  usage(1);
}

async function resolveAccountId(explicitAccountId: string | undefined): Promise<string> {
  const credentials = await readCredentials();
  const accountId = selectedAccountId(explicitAccountId, credentials);
  if (accountId) {
    return accountId;
  }
  const response = await apiFetch<AccountsResponse>("/v0/accounts", { method: "GET" });
  return response.default_account_id;
}

function printRoutes(routes: RouteRecord[]): void {
  for (const route of routes) {
    printRoute(route);
  }
}

function printRoute(route: RouteRecord): void {
  console.log([
    route.route_id,
    route.route_type,
    route.status,
    route.hostname,
    route.slug ?? "",
    route.reason ?? ""
  ].join("\t"));
  if (route.verification && Object.keys(route.verification).length > 0) {
    console.log(`verification=${JSON.stringify(route.verification)}`);
  }
}

async function printObject(value: Record<string, unknown>): Promise<void> {
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        console.log(`${key}=${isPlainObject(item) ? formatFields(item) : String(item)}`);
      }
    } else if (isPlainObject(entry)) {
      console.log(`${key}=${JSON.stringify(entry)}`);
    } else {
      console.log(`${key}=${entry ?? ""}`);
    }
  }
}

function printKeyValues(prefix: string, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`${prefix}=${key} value=${value === null ? "unlimited" : formatFieldValue(value)}`);
  }
}

function printList(label: string, values: string[] | undefined): void {
  if (values && values.length > 0) {
    console.log(`${label}=${values.join(",")}`);
  }
}

function printWarnings(warnings: Array<{ code?: string; message?: string }> | undefined): void {
  for (const warning of warnings ?? []) {
    console.log(`warning=${formatFields(warning as Record<string, unknown>)}`);
  }
}

function printOptionalBoolean(label: string, value: unknown): void {
  if (typeof value === "boolean") {
    console.log(`${label}=${value}`);
  }
}

async function readPublishDirectory(rootDir: string, options: CliOptions): Promise<Record<string, unknown>> {
  const absoluteRoot = path.resolve(rootDir);
  const stat = await fs.stat(absoluteRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Directory not found: ${rootDir}`);
  }

  const { document: manifest, file: manifestFile } = await readManifest(absoluteRoot);
  const files = await readReleaseFiles(absoluteRoot, manifest, manifestFile, { printSkipped: options.skipLocalValidation === true });
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

const READ_WITHOUT_FOLLOWING_LINKS = fsConstants.O_NOFOLLOW === undefined ? "r" : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

/**
 * Reads the release files. Every path is checked again here, including with --skip-local-validation:
 * paths the API would reject, symlinks, files outside the app folder, and private keys are never read
 * or sent.
 */
async function readReleaseFiles(
  rootDir: string,
  manifest: Record<string, unknown>,
  manifestFile: string | null,
  output: { printSkipped: boolean }
): Promise<Array<{ path: string; content_type: string; content_base64: string }>> {
  if (Array.isArray(manifest.files)) {
    manifest.files.forEach((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("manifest.userland.json files entries must be objects.");
      }
      if (typeof (entry as { path?: unknown }).path !== "string") {
        throw new Error("manifest.userland.json files entries require path.");
      }
    });
  }
  const listing = await listReleaseFiles(rootDir, manifest, { manifestFile });
  if (listing.privateKeys.length > 0) {
    throw new Error(`Not publishing: ${listing.privateKeys.join(", ")} ${privateKeyMessage()}`);
  }
  if (output.printSkipped) {
    for (const warning of releaseListingWarnings(listing)) {
      console.error(formatWarning(warning));
    }
  }
  const files: Array<{ path: string; content_type: string; content_base64: string }> = [];
  for (const entry of listing.files) {
    const problem = await releaseFileProblem(rootDir, entry.path);
    if (!problem.ok) {
      throw new Error(`Not publishing: ${entry.path} ${problem.message}`);
    }
    const contents = await fs.readFile(entry.absolutePath, { flag: READ_WITHOUT_FOLLOWING_LINKS });
    files.push({
      path: entry.path,
      content_type: entry.contentType ?? contentTypeForPath(entry.path),
      content_base64: contents.toString("base64")
    });
  }

  if (files.length === 0) {
    throw new Error("Publish directory must contain at least one file.");
  }

  return files;
}

async function readManifest(rootDir: string): Promise<{ document: Record<string, unknown>; file: string | null }> {
  const found = await findManifest(rootDir);
  if (!found.ok) {
    throw new Error(found.message);
  }
  return { document: found.document, file: found.file };
}

/**
 * Calls the API with the selected key. Human output prints API text, so strings in the response come
 * back with control characters shown as visible escapes; pass `raw` for output printed as JSON.
 */
async function apiFetch<T>(apiPath: string, init: RequestInit, options: { accountId?: string; accountScoped?: boolean; raw?: boolean } = {}): Promise<T> {
  const credentials = await readCredentials();
  const target = apiTarget(credentials);
  if (!target.apiKey) {
    throw new Error("USERLAND_API_KEY is required. Run `userland signup` or `userland login` to save credentials.");
  }
  if (target.conflict) {
    throw new Error(target.conflict);
  }
  noteSavedApiBaseUrl(target);

  const accountId = options.accountScoped ? selectedAccountId(options.accountId, credentials) : undefined;
  const headers: Record<string, string> = {
    authorization: `Bearer ${target.apiKey}`,
    ...(init.headers as Record<string, string> | undefined)
  };
  if (accountId) {
    headers["x-userland-account-id"] = accountId;
  }
  const body = await requestJson<T>(target.baseUrl, apiPath, {
    ...init,
    headers
  });
  return options.raw ? body : terminalSafeValue(body);
}

/**
 * One part of an API path taken from the command line or the credentials file (an app id, slug,
 * domain, API key id, or account id), URL-encoded. "." and ".." are refused: URL parsing drops them
 * before the request is sent, so `apps slugs remove <app-id> ..` would become DELETE /v0/apps/<app-id>,
 * which unpublishes the app, and `--app .` would become PUT /v0/apps/, which creates a new app.
 * Encoding turns "%" into "%25", so a percent-encoded dot such as "%2e" cannot become a dot again.
 */
function pathSegment(value: string, label: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}. It cannot be ".", "..", or empty.`);
  }
  return encodeURIComponent(value);
}

function selectedAccountId(explicitAccountId: string | undefined, credentials: CredentialsFile | undefined): string | undefined {
  return explicitAccountId ?? envValue("USERLAND_ACCOUNT_ID") ?? credentials?.account_id;
}

/** An environment variable, treating an empty or blank value as unset. */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

interface ApiTarget {
  apiKey: string | undefined;
  keySource: "env" | "file" | "missing";
  baseUrl: string;
  baseUrlSource: "env" | "file" | "default";
  /** Set when the saved key would be sent to a different API than the one it was saved for. */
  conflict?: string;
}

/**
 * Picks the API key and the API it is sent to as a pair. USERLAND_API_KEY goes to
 * USERLAND_API_BASE_URL or the default API, never to a URL saved in the credentials file. A saved key
 * only goes to the API it was saved with.
 */
function apiTarget(credentials: CredentialsFile | undefined): ApiTarget {
  const envKey = envValue("USERLAND_API_KEY");
  const envBaseUrl = envValue("USERLAND_API_BASE_URL");
  if (envKey) {
    return { apiKey: envKey, keySource: "env", baseUrl: envBaseUrl ?? DEFAULT_API_BASE_URL, baseUrlSource: envBaseUrl ? "env" : "default" };
  }
  if (!credentials?.api_key) {
    return { apiKey: undefined, keySource: "missing", baseUrl: envBaseUrl ?? DEFAULT_API_BASE_URL, baseUrlSource: envBaseUrl ? "env" : "default" };
  }
  const savedBaseUrl = credentials.api_base_url ?? DEFAULT_API_BASE_URL;
  const target: ApiTarget = { apiKey: credentials.api_key, keySource: "file", baseUrl: savedBaseUrl, baseUrlSource: credentials.api_base_url ? "file" : "default" };
  if (envBaseUrl !== undefined && !sameApi(envBaseUrl, savedBaseUrl)) {
    target.conflict = `The saved API key is for ${terminalSafe(savedBaseUrl)}, but USERLAND_API_BASE_URL is ${terminalSafe(envBaseUrl)}. The CLI only sends a saved key to the API it was saved for. Set USERLAND_API_KEY to a key for that API, log in again with USERLAND_API_BASE_URL set, or unset USERLAND_API_BASE_URL.`;
  } else if (envBaseUrl !== undefined) {
    target.baseUrlSource = "env";
  }
  return target;
}

let savedApiBaseUrlNoted = false;

/** Says so on stderr when a saved key is used with an API other than the default one. */
function noteSavedApiBaseUrl(target: ApiTarget): void {
  if (savedApiBaseUrlNoted || target.baseUrlSource !== "file" || sameApi(target.baseUrl, DEFAULT_API_BASE_URL)) {
    return;
  }
  savedApiBaseUrlNoted = true;
  console.error(`note=api_base_url Using the API at ${terminalSafe(target.baseUrl)}, saved with this API key in ${credentialsPath()}.`);
}

/** True when two base URLs name the same API (ignoring case in the host and trailing slashes). */
function sameApi(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    } catch {
      return value.replace(/\/+$/u, "");
    }
  };
  return normalize(left) === normalize(right);
}

/**
 * Checks a URL the CLI sends API keys to or opens in a browser: it must parse, use https (http only
 * for localhost), and carry no user name or password.
 */
function assertServiceUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL: ${terminalSafe(value)}`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include a user name or password: ${url.origin}`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return url;
  }
  throw new Error(`${label} must start with https:// (http:// is allowed only for localhost): ${url.protocol === "http:" ? url.origin : terminalSafe(value)}`);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname);
}

async function pollDeviceAuthorization(baseUrl: string, start: DeviceStartResponse): Promise<Extract<DevicePollResponse, { ok: true }>> {
  let intervalSeconds = positiveNumber(start.interval, 5);
  const deadline = Date.now() + positiveNumber(start.expires_in, 900) * 1000;

  while (Date.now() <= deadline) {
    const poll = await requestJson<DevicePollResponse>(baseUrl, "/v0/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ device_code: start.device_code })
    });

    if (poll.ok) {
      return poll;
    }

    if (poll.status === "authorization_pending") {
      await sleep(intervalSeconds * 1000);
      continue;
    }

    if (poll.status === "slow_down") {
      intervalSeconds = positiveNumber(poll.interval, intervalSeconds + 5);
      await sleep(intervalSeconds * 1000);
      continue;
    }

    throw new Error(deviceAuthorizationStatusMessage(poll.status));
  }

  throw new Error("Device authorization expired before approval.");
}

function deviceAuthorizationStatusMessage(status: Exclude<Extract<DevicePollResponse, { ok: false }>["status"], "authorization_pending" | "slow_down">): string {
  if (status === "denied") {
    return "Device authorization was denied in the browser.";
  }
  if (status === "expired") {
    return "Device authorization expired before approval.";
  }
  return "Device authorization was already consumed. Run `userland login` again.";
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestJson<T>(baseUrl: string, apiPath: string, init: RequestInit): Promise<T> {
  const base = assertServiceUrl(baseUrl, "API base URL");
  const response = await fetch(`${base.href.replace(/\/$/u, "")}${apiPath}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    throw new ApiError(`API ${response.status}: the response was not JSON.`, response.status, undefined, undefined, undefined);
  }
  if (!response.ok) {
    const message = errorMessage(body) ?? response.statusText;
    const parsed = isPlainObject(body) ? parseApiError(body) : {};
    throw new ApiError(`API ${response.status}: ${message}`, response.status, parsed.code, parsed.details, body);
  }

  return body as T;
}

/** Opens a checked https (or localhost http) URL without going through a shell. */
async function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // `cmd /c start` would run anything after & or | in the URL; rundll32 hands it straight to the browser.
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];

  return await new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function credentialsPath(): string {
  return envValue("USERLAND_CREDENTIALS_FILE") ?? defaultCredentialsPath();
}

function defaultCredentialsPath(): string {
  return path.join(os.homedir(), ".userland", "credentials.json");
}

async function readCredentials(): Promise<CredentialsFile | undefined> {
  const filePath = credentialsPath();
  const contents = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!contents) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // The parser's message quotes the start of the file, which can be an API key.
    throw new Error(`Credentials file ${filePath} is not valid JSON. Fix it, or delete it and run \`userland login\` again.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credentials file must contain a JSON object: ${filePath}`);
  }
  const credentials = parsed as CredentialsFile;
  return {
    account_id: stringValue(credentials.account_id),
    api_base_url: stringValue(credentials.api_base_url),
    api_key: stringValue(credentials.api_key),
    api_key_id: stringValue(credentials.api_key_id),
    console_url: stringValue(credentials.console_url),
    updated_at: stringValue(credentials.updated_at),
    username: stringValue(credentials.username)
  };
}

/**
 * Writes the credentials file with 0600 permissions: to a new file in the same folder first, then
 * renamed over the old one, so the key is never in a file with looser permissions and a failed write
 * leaves the old file intact. The folder is set to 0700 only when the CLI creates it or it is the
 * default ~/.userland folder, never a shared folder named by USERLAND_CREDENTIALS_FILE.
 */
async function saveCredentials(update: CredentialsUpdate): Promise<string> {
  return (await replaceCredentials(update)).filePath;
}

/**
 * saveCredentials, also returning what the file held right before this write. Login uses it to
 * revoke the key it actually overwrites, which can differ from the key saved when the login started
 * if another login (for example a parallel agent) saved one while this one waited for approval.
 */
async function replaceCredentials(update: CredentialsUpdate): Promise<{ filePath: string; replaced: CredentialsFile | undefined }> {
  const filePath = credentialsPath();
  const dir = path.dirname(filePath);
  const created = await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined || path.resolve(filePath) === path.resolve(defaultCredentialsPath())) {
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }

  // Read as late as possible, so what this write replaces is what is actually in the file.
  const replaced = await readCredentials();
  const sanitizedUpdate = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) as CredentialsFile;
  const credentials: CredentialsFile = {
    ...replaced,
    ...sanitizedUpdate,
    updated_at: new Date().toISOString()
  };
  for (const [key, value] of Object.entries(update)) {
    if (value === null) {
      delete credentials[key as keyof CredentialsFile];
    }
  }

  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.chmod(tempPath, 0o600).catch(() => undefined);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { filePath, replaced };
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--app") {
      options.app = requireOptionValue(arg, args[++index]);
    } else if (arg === "--message") {
      options.message = requireOptionValue(arg, args[++index], { allowEmpty: true, freeText: true });
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else if (arg === "--plan") {
      options.plan = requireOptionValue(arg, args[++index]);
    } else if (arg === "--skip-local-validation") {
      options.skipLocalValidation = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.plan !== undefined && options.skipLocalValidation) {
    throw new Error("--plan cannot be combined with --skip-local-validation.");
  }
  return options;
}

function parseValidateOptions(args: string[]): ValidateOptions {
  const options: ValidateOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--plan") {
      options.plan = requireOptionValue(arg, args[++index]);
    } else if (arg === "--strict") {
      options.strict = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseAnalyticsOptions(args: string[]): AnalyticsOptions {
  const options: AnalyticsOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--range") {
      options.range = args[++index] ?? "";
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

/** Every option the CLI accepts. A free-text value that is exactly one of these is a forgotten value. */
const CLI_OPTION_NAMES = new Set([
  "--account",
  "--api-base-url",
  "--api-key",
  "--app",
  "--console-url",
  "--cursor",
  "--email",
  "--expires-in-days",
  "--help",
  "--json",
  "--limit",
  "--message",
  "--name",
  "--no-browser",
  "--no-save",
  "--password",
  "--plan",
  "--range",
  "--release",
  "--revoke",
  "--role",
  "--save=false",
  "--severity",
  "--skip-local-validation",
  "--strict",
  "--subject",
  "--to",
  "--type",
  "--username",
  "--value",
  "--yes",
  "-y"
]);

/**
 * Returns a flag's value. A missing value, a value that is another flag, and (unless allowEmpty) an
 * empty or blank value are usage errors: `--app "$APP_ID"` with an unset variable must not publish
 * a new app, and `--account ""` must not fall back to the default account.
 *
 * Ids, URLs, emails, plans, and filters never start with "--", so for those any value starting with
 * "--" counts as another flag. Free text and secret values (freeText) can start with dashes, such as
 * a PEM key's "-----BEGIN", so for them only an exact option name such as `--account` counts.
 */
function requireOptionValue(flag: string, value: string | undefined, options: { allowEmpty?: boolean; freeText?: boolean } = {}): string {
  if (value === undefined) {
    throw new Error(`${flag} requires a value.`);
  }
  if (options.freeText ? CLI_OPTION_NAMES.has(value) : value.startsWith("--")) {
    throw new Error(`${flag} requires a value. The next argument (${value}) looks like another option.`);
  }
  if (!options.allowEmpty && value.trim() === "") {
    throw new Error(`${flag} requires a value, but it was empty. If you passed a variable such as "$APP_ID", check that it is set.`);
  }
  return value;
}

function parseSupportOptions(args: string[]): SupportOptions {
  const options: SupportOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--subject") {
      options.subject = requireOptionValue(arg, args[++index], { freeText: true });
    } else if (arg === "--message") {
      options.message = requireOptionValue(arg, args[++index], { allowEmpty: true, freeText: true });
    } else if (arg === "--app") {
      options.app = requireOptionValue(arg, args[++index]);
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseAuthOptions(args: string[]): AuthOptions {
  const options: AuthOptions = { save: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--username" || arg === "--password") {
      throw new Error("Userland platform auth is passwordless. Run `userland login` without username/password flags.");
    } else if (arg === "--email") {
      options.email = requireOptionValue(arg, args[++index]);
    } else if (arg === "--api-key") {
      options.apiKey = requireOptionValue(arg, args[++index]);
    } else if (arg === "--no-save") {
      options.save = false;
    } else if (arg === "--save=false") {
      options.save = false;
    } else if (arg === "--no-browser") {
      options.noBrowser = true;
    } else if (arg === "--api-base-url") {
      options.apiBaseUrl = requireOptionValue(arg, args[++index]);
    } else if (arg === "--console-url") {
      options.consoleUrl = requireOptionValue(arg, args[++index]);
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else if (arg === "--revoke") {
      options.revoke = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseApiKeyOptions(args: string[]): ApiKeyOptions {
  const options: ApiKeyOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--name") {
      options.name = requireOptionValue(arg, args[++index], { freeText: true });
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
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
      options.value = requireOptionValue(arg, args[++index], { freeText: true });
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
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
      options.type = requireOptionValue(arg, args[++index]);
    } else if (arg === "--severity") {
      options.severity = requireOptionValue(arg, args[++index]);
    } else if (arg === "--release") {
      options.releaseId = requireOptionValue(arg, args[++index]);
    } else if (arg === "--limit") {
      options.limit = requireOptionValue(arg, args[++index]);
    } else if (arg === "--cursor") {
      options.cursor = requireOptionValue(arg, args[++index]);
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseSecretsListOptions(args: string[]): SecretsListOptions {
  const options: SecretsListOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseSecretDeleteOptions(args: string[]): SecretDeleteOptions {
  const options: SecretDeleteOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseInviteCreateOptions(args: string[]): InviteCreateOptions {
  const options: InviteCreateOptions = { roles: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--email") {
      options.email = requireOptionValue(arg, args[++index]);
    } else if (arg === "--role") {
      const role = requireOptionValue(arg, args[++index]);
      if (role.includes(",")) {
        throw new Error(`Pass one role for each --role, for example --role staff --role owner, not --role ${role}.`);
      }
      options.roles.push(role);
    } else if (arg === "--expires-in-days") {
      options.expiresInDays = requireOptionValue(arg, args[++index]);
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseUnpublishOptions(args: string[]): UnpublishOptions {
  const options: UnpublishOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseDowngradePreviewOptions(args: string[]): DowngradePreviewOptions {
  const options: DowngradePreviewOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--to") {
      options.to = requireOptionValue(arg, args[++index]);
    } else if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseAccountOptions(args: string[]): { account?: string } {
  const options: { account?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--account") {
      options.account = requireOptionValue(arg, args[++index]);
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

/** Reads a line from the terminal without showing what is typed (for API keys). */
async function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const hidden = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const readline = createInterface({ input: process.stdin, output: hidden, terminal: true });
  readline.on("SIGINT", () => {
    readline.close();
    process.stdout.write("\n");
    process.exit(130);
  });
  try {
    return (await readline.question("")).trim();
  } finally {
    readline.close();
    process.stdout.write("\n");
  }
}

/**
 * Reads one line from the terminal. Returns "" when input ends before a line is entered (Ctrl-D),
 * which callers treat as "no", instead of leaving the question open and exiting without a word.
 */
async function promptLine(prompt: string, output: NodeJS.WritableStream = process.stdout): Promise<string> {
  const readline = createInterface({ input: process.stdin, output });
  readline.on("SIGINT", () => {
    readline.close();
    output.write("\n");
    process.exit(130);
  });
  let answered = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      readline.once("close", () => {
        // Checked a turn later, so a line typed right before the input ended still counts.
        setImmediate(() => {
          if (!answered) {
            output.write("\n");
            resolve("");
          }
        });
      });
      readline.question(prompt).then((answer) => {
        answered = true;
        resolve(answer.trim());
      }, reject);
    });
  } finally {
    readline.close();
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function formatFields(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined && entry !== null)
    .map(([key, entry]) => `${key}=${formatFieldValue(entry)}`)
    .join(" ");
}

function formatFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return /\s/u.test(value) ? JSON.stringify(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(formatFieldValue).join(",");
  }
  if (isPlainObject(value)) {
    return JSON.stringify(value);
  }
  return String(value);
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
  if (!isPlainObject(body) || !("error" in body)) {
    return undefined;
  }

  const parsed = parseApiError(body);
  if (!parsed.message && !parsed.code) {
    return undefined;
  }
  const lines = [parsed.message ?? parsed.code];
  if (parsed.code) {
    lines.push(`error=${parsed.code}`);
  }
  lines.push(...structuredDetailLines(parsed.details));
  if (parsed.code === "platform_deploy_failed") {
    lines.push(...deployFailureLines(parsed.details));
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * platform_deploy_failed details: why the app's server code did not answer its health check in time
 * (reason, status, attempts), or why the upload failed (status, and the host's errors as
 * upload_error lines). Only strings and finite numbers are printed. What to do next depends on the
 * command, so the command adds it (withRollbackOutcome). Other errors print as before.
 */
function deployFailureLines(details: unknown): string[] {
  if (!isPlainObject(details)) {
    return [];
  }
  const lines: string[] = [];
  for (const key of ["reason", "status", "attempts"]) {
    const value = details[key];
    if (isPrintableScalar(value)) {
      lines.push(`${key}=${formatFieldValue(value)}`);
    }
  }
  const errors = Array.isArray(details.errors) ? details.errors : [];
  for (const entry of errors) {
    if (isPlainObject(entry) && typeof entry.message === "string" && entry.message.trim() !== "") {
      lines.push(`upload_error=${formatFieldValue(entry.message)}${isPrintableScalar(entry.code) ? ` code=${formatFieldValue(entry.code)}` : ""}`);
    }
  }
  return lines;
}

function isPrintableScalar(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Whether running a failed server update again can work. The API sends platform_deploy_failed when
 * the uploaded server code did not answer its health check in time ("User Worker activation probe
 * failed.", with attempts), when the upload failed ("User Worker upload failed.", with the host's
 * status), or when the upload could not be checked at all ("User Worker upload could not be
 * probed.", no details). A late health check, which happens when a rollback runs seconds after a
 * newer publish, and an upload the host could not take just then (a 5xx, a 429, or no status)
 * usually work a minute later. An upload the host refused (any other 4xx, such as code that is too
 * large or fails at startup) and an upload that could not be checked fail the same way every time.
 */
function deployFailureRetryHelps(message: string | undefined, details: unknown): boolean {
  const fields = isPlainObject(details) ? details : {};
  if (fields.attempts !== undefined || message === "User Worker activation probe failed.") {
    return true;
  }
  if (message === "User Worker upload failed." || fields.status !== undefined) {
    const status = fields.status;
    return !(typeof status === "number" && status >= 400 && status < 500 && status !== 429);
  }
  return false;
}

/**
 * A rollback uploads the target release's server code again and checks that it answers before the
 * app moves to that release, so a platform_deploy_failed rollback left the app where it was. The
 * error says so in plain words, then says to run the command again when that can work, or to send
 * the output to support when it cannot. Other errors are returned unchanged.
 */
function withRollbackOutcome(error: unknown, appId: string): unknown {
  if (!(error instanceof ApiError) || error.code !== "platform_deploy_failed") {
    return error;
  }
  const apiMessage = isPlainObject(error.body) ? parseApiError(error.body).message : undefined;
  const next = deployFailureRetryHelps(apiMessage, error.details)
    ? "Run the same command again in a minute."
    : `Running the same command again will not fix this. Send this output to support: userland support open --subject "Rollback failed" --app ${terminalSafe(appId)}`;
  return new ApiError(
    `${error.message}\nThe rollback did not happen: your app is still on its current release. ${next}`,
    error.status,
    error.code,
    error.details,
    error.body
  );
}

function parseApiError(body: Record<string, unknown>): { code?: string; message?: string; details?: unknown } {
  const error = body.error;
  if (typeof error === "string") {
    return {
      code: error,
      message: stringValue(body.message),
      details: body.details
    };
  }
  if (!isPlainObject(error)) {
    return {};
  }
  return {
    code: stringValue(error.code),
    message: stringValue(error.message),
    details: error.details
  };
}

function structuredDetailLines(details: unknown): string[] {
  if (!isPlainObject(details)) {
    return [];
  }

  const lines: string[] = [];
  for (const key of ["metric", "plan_key", "required_plan_key", "limit", "limit_key", "current", "increment", "value", "upgrade_required", "self_serve_upgrade", "upgrade_url", "support_url"]) {
    if (details[key] !== undefined) {
      lines.push(`${key}=${formatFieldValue(details[key])}`);
    }
  }

  const violations = Array.isArray(details.violations) ? details.violations : [];
  for (const violation of violations) {
    if (isPlainObject(violation)) {
      lines.push(`violation=${formatViolation(violation)}`);
    }
  }
  return lines;
}

function formatViolation(value: Record<string, unknown>): string {
  const path = stringValue(value.manifest_path);
  const feature = stringValue(value.feature_key);
  const limit = stringValue(value.limit_key);
  const requiredPlan = stringValue(value.required_plan_key);
  const actualValue = value.value;
  const allowed = value.allowed;
  const parts = [
    path,
    feature ? `feature=${feature}` : undefined,
    limit ? `limit=${limit}` : undefined,
    actualValue !== undefined ? `value=${Array.isArray(actualValue) ? actualValue.join(",") : String(actualValue)}` : undefined,
    allowed !== undefined ? `allowed=${formatAllowed(allowed)}` : undefined,
    requiredPlan ? `requires=${requiredPlan}` : undefined
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : formatFields(value);
}

function formatAllowed(value: unknown): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function docsUrlForError(message: string): string {
  if (message.startsWith("Unknown plan:")) {
    return LIMITS_DOCS_URL;
  }
  if (message.includes("entitlement_required") || message.includes("plan_limit_exceeded")) {
    return LIMITS_DOCS_URL;
  }
  if (message.includes("quota_exceeded") || message.includes("downgrade_incompatible")) {
    return "https://docs.userland.fun/reference/errors";
  }
  if (message.includes("USERLAND_API_KEY") || message.includes("credentials")) {
    return "https://docs.userland.fun/reference/cli";
  }
  if (message.includes("secrets") || message.includes("pending_secrets")) {
    return "https://docs.userland.fun/guides/secrets";
  }
  if (message.includes("error=auth_disabled") || message.includes("error=invalid_role")) {
    return "https://docs.userland.fun/guides/auth";
  }
  if (message.includes("rollback")) {
    return "https://docs.userland.fun/guides/rollback";
  }
  return "https://docs.userland.fun/guides/troubleshooting";
}

function isHelpCommand(command: string | undefined): boolean {
  return command === "--help" || command === "-h" || command === "help";
}

function isVersionCommand(command: string | undefined): boolean {
  return command === "--version" || command === "version";
}

function usage(exitCode: number): never {
  const message = `Usage:
  userland [--help]
  userland --version
  userland signup [--no-browser] [--email <email>] [--api-base-url <url>] [--console-url <url>] [--no-save]
  userland login [--no-browser] [--email <email>] [--api-base-url <url>] [--console-url <url>] [--no-save]
  userland auth status
  userland auth save-key [--account <account-id>] [--api-base-url <url>] [--console-url <url>]   (reads the key from stdin or a hidden prompt)
  userland auth logout [--revoke]
  userland auth api-keys list
  userland auth api-keys create --name <name>
  userland auth api-keys rename <api-key-id> --name <name>
  userland auth api-keys revoke <api-key-id> [--yes]
  userland accounts list
  userland accounts use <account-id>
  userland accounts status [--account <account-id>]
  userland accounts limits [--account <account-id>]
  userland accounts downgrade preview --to <plan> [--account <account-id>]
  userland support open --subject <subject> [--message <message>] [--app <app-id>] [--account <account-id>] [--json]
  userland validate <dir> [--plan <plan>] [--strict] [--json]
  userland apps publish <dir> [--app <app-id>] [--message <message>] [--account <account-id>] [--plan <plan>] [--skip-local-validation]
  userland apps list [--account <account-id>]
  userland apps status <app-id> [--account <account-id>]
  userland apps releases <app-id> [--account <account-id>]
  userland apps rollback <app-id> <release-id> [--account <account-id>]
  userland apps unpublish <app-id> [--yes] [--account <account-id>] [--json]
  userland apps secrets list <app-id> [--account <account-id>] [--json]
  userland apps secrets set <app-id> <NAME> [--account <account-id>]   (reads the value from stdin)
  userland apps secrets delete <app-id> <NAME> [--yes] [--account <account-id>]
  userland apps invites create <app-id> --email <email> [--role <role>]... [--expires-in-days <1-30>] [--account <account-id>] [--json]
  userland apps events <app-id> [--type <event-type>] [--severity <level>] [--release <release-id>] [--limit <n>] [--cursor <cursor>] [--account <account-id>]
  userland apps analytics <app-id> [--range 7d|30d|90d] [--account <account-id>] [--json]
  userland apps routes list <app-id> [--account <account-id>]
  userland apps slugs list <app-id> [--account <account-id>]
  userland apps slugs add <app-id> <slug> [--account <account-id>]
  userland apps slugs remove <app-id> <slug> [--account <account-id>]
  userland apps domains list <app-id> [--account <account-id>]
  userland apps domains add <app-id> <hostname> [--account <account-id>]
  userland apps domains verify <app-id> <hostname> [--account <account-id>]
  userland apps domains remove <app-id> <hostname> [--account <account-id>]

Aliases:
  userland auth signup [--no-browser] [--email <email>] [--no-save]
  userland auth login [--no-browser] [--email <email>] [--no-save]
  userland api-keys list|create|rename|revoke ...
  userland publish <dir> [--app <app-id>] [--message <message>] [--account <account-id>] [--plan <plan>] [--skip-local-validation]
  userland analytics <app-id> [--range 7d|30d|90d] [--account <account-id>] [--json]
  userland releases <app-id> [--account <account-id>]
  userland versions <app-id> [--account <account-id>]

Validation:
  validate checks manifest.userland.json against the public schema, file paths, and plan limits offline.
  Plans: free, starter, business, business_plus. Without --plan it reports the minimum plan.
  Schema rules the API does not enforce are schema_strict warnings; --strict fails on them too.
  Exit codes: 0 valid, 1 manifest or file errors, 2 plan limits exceeded.
  apps publish runs the same checks first, using --plan or the account's plan; the API stays authoritative.

Credentials:
  Commands use USERLAND_API_KEY first, then ~/.userland/credentials.json for API keys.
  USERLAND_API_KEY goes to USERLAND_API_BASE_URL or https://api.userland.fun; a saved key only goes to the API it was saved for.
  API URLs must use https:// (http:// only for localhost).
  App commands use --account, then USERLAND_ACCOUNT_ID, then saved account_id when set.
  Login and signup use browser device authorization and save only API-key credentials locally.
  A new login revokes the API key saved by the previous login for the same API.
  Pipe secrets and API keys on stdin: printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>
  (--value and --api-key still work, but the value can be kept in shell history.)

Publishing a folder:
  Without manifest files, apps publish uploads every regular file except manifest.userland.json.
  Names that start with a dot (.env, .npmrc, .git/, and so on) are left out, except .well-known/
  and dot-folders named in runtime.static_root or runtime.server_entry. Symlinks are never followed.
  Private keys (such as id_rsa or a .pem file holding a private key) stop the publish.

Unpublishing:
  apps unpublish takes an app offline, removes its slugs and custom domains, and removes it from
  apps list. Its release history is kept. In a terminal it shows the app's name, address, and account
  and asks you to type the app id or y. Without a terminal (scripts, CI, agents) check with the app's
  owner, then pass --yes. When an account is selected (--account, USERLAND_ACCOUNT_ID, or the saved
  account), an app that belongs to a different account is not unpublished.

Secrets:
  secrets list shows the name of each secret that is set, when it was first set, and when it was last
  set. It never shows values. secrets delete removes a secret's value at once: server code that reads
  it stops getting it, and the value cannot be brought back, only set again. It deletes only a name
  that is set. In a terminal it asks you to type the name or y. Without a terminal (scripts, CI,
  agents) check with the app's owner, then pass --yes. When an account is selected, a secret of an app
  in a different account is not deleted.

Invites:
  invites create makes an invite for one person to sign in to the app (as a user of the app, not of
  your Userland account) and prints only the invite link. Give the link to that person only: whoever
  has it can use it once to set a password. Pass --role once for each role, using roles the app's
  manifest declares; with no --role the person gets no special role. The link lasts 7 days, or 1 to
  30 days with --expires-in-days. It works with the key saved by userland login, so you do not need
  to make another API key for it.

Events:
  apps events lists the newest events first, up to 100 at a time (--limit). When there are more, the
  last line is cursor=<cursor>. To read the next, older page, run the same command again with
  --cursor <cursor> added.

Docs:
  https://docs.userland.fun/reference/cli
  https://docs.userland.fun/guides/troubleshooting`;
  if (exitCode === 0) {
    console.log(message);
  } else {
    console.error(message);
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Error text can quote the API or file names, so show control characters as visible escapes.
  console.error(terminalSafeLines(message));
  console.error(`Docs: ${docsUrlForError(message)}`);
  process.exit(1);
});

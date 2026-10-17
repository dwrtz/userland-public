#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { nativeSecretsCommand } from "./nativeSecrets.js";
import { nativeCommand } from "./native.js";
import { nativeDataCommand } from "./nativeData.js";
import { nativeDomainsCommand } from "./nativeDomains.js";
import { accountMembershipCommand } from "./accountMembership.js";
import { terminalSafe, terminalSafeLines, terminalSafeValue } from "./terminal.js";
const LIMITS_DOCS_URL = "https://docs.userland.fun/reference/limits/";

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

class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly body: unknown;
  /** The answer's Retry-After header, for the requests the CLI tries again (upload sessions). */
  readonly retryAfter: string | null;

  constructor(message: string, status: number, code: string | undefined, details: unknown, body: unknown, retryAfter: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.body = body;
    this.retryAfter = retryAfter;
  }
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

  if(command==="apps"&&args[0]==="secrets"){
    await nativeSecretsCommand(args.slice(1),{apiFetch,pathSegment,print:(line)=>console.log(line)});return;
  }
  if (command === "resources" || command === "apps" && args[0] === "restore") {
    await nativeDataCommand(command,args,{apiFetch,pathSegment,print:(line)=>console.log(line)});return;
  }
  if(command==="routes"&&["set","remove"].includes(args[0])){
    await nativeDomainsCommand(args,{apiFetch,pathSegment,print:(line)=>console.log(line)});return;
  }
  if (command === "context" || command === "operations" || (command === "apps" && ["get", "apply", "run", "stop", "resume", "delete"].includes(args[0]))) {
    await nativeCommand(command, args, { apiFetch, pathSegment, print: (line) => console.log(line) });
    return;
  }

  if (command === "apps") throw new Error("Use native apps get|apply|run|stop|resume|delete|restore or secrets. Read userland context first.");

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

  if (command === "signup") {
    await signupCommand(args);
    return;
  }

  if (command === "login") {
    await loginCommand(args);
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
  if (args[0] === "members" || args[0] === "invitations") {
    await accountMembershipCommand(args, { apiFetch, resolveAccountId, pathSegment, prompt: promptLine, interactive: Boolean(process.stdin.isTTY), print: (line) => console.log(line) });
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    await listAccountsCommand();
    return;
  }
  if (subcommand === "use") {
    await useAccountCommand(rest);
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

async function resolveAccountId(explicitAccountId: string | undefined): Promise<string> {
  const credentials = await readCredentials();
  const accountId = selectedAccountId(explicitAccountId, credentials);
  if (accountId) {
    return accountId;
  }
  const response = await apiFetch<AccountsResponse>("/v0/accounts", { method: "GET" });
  return response.default_account_id;
}

/**
 * A custom domain's `dns_instructions`, one line each: the records to add (the traffic record, the
 * ownership TXT record, and any the certificate provider asks for, each once), whether the ownership
 * record was found, what the last check says is still missing, and when it last checked.
 */
function dnsInstructionLines(instructions: unknown): string[] {
  if (!isPlainObject(instructions)) {
    return [];
  }
  const lines: string[] = [];
  const addRecord = (purpose: string, record: Record<string, unknown>) => {
    const line = `dns_record=${purpose} ${formatFields(record)}`;
    if (!lines.includes(line)) lines.push(line);
  };
  const traffic = isPlainObject(instructions.traffic) ? instructions.traffic : isPlainObject(instructions.cname) ? instructions.cname : undefined;
  if (traffic && isPrintableScalar(traffic.name) && isPrintableScalar(traffic.value)) {
    addRecord("traffic", { type: traffic.type, name: traffic.name, value: traffic.value, note: traffic.note });
  }
  const ownership = instructions.ownership_txt;
  if (isPlainObject(ownership) && isPrintableScalar(ownership.name) && isPrintableScalar(ownership.value)) {
    addRecord("ownership_txt", { type: ownership.type ?? "TXT", name: ownership.name, value: ownership.value });
  }
  const validation = instructions.provider_validation_records;
  for (const entry of Array.isArray(validation) ? validation : isPlainObject(validation) ? [validation] : []) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.txt_name === "string" && typeof entry.txt_value === "string") {
      addRecord("provider_validation", { type: "TXT", name: entry.txt_name, value: entry.txt_value });
    } else if (typeof entry.cname === "string" && typeof entry.cname_target === "string") {
      addRecord("provider_validation", { type: "CNAME", name: entry.cname, value: entry.cname_target });
    }
  }
  if (isPrintableScalar(instructions.ownership_status)) {
    lines.push(`dns_ownership_status=${formatFieldValue(instructions.ownership_status)}`);
  }
  for (const error of Array.isArray(instructions.verification_errors) ? instructions.verification_errors : []) {
    if (typeof error === "string" && error.trim() !== "") {
      lines.push(`dns_verification_error=${formatFieldValue(error)}`);
    }
  }
  if (isPrintableScalar(instructions.last_refreshed_at)) {
    lines.push(`dns_last_refreshed_at=${formatFieldValue(instructions.last_refreshed_at)}`);
  }
  return lines;
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
    throw new ApiError(`API ${response.status}: the response was not JSON.`, response.status, undefined, undefined, undefined, response.headers.get("retry-after"));
  }
  if (!response.ok) {
    const message = errorMessage(body) ?? response.statusText;
    const parsed = isPlainObject(body) ? parseApiError(body) : {};
    throw new ApiError(`API ${response.status}: ${message}`, response.status, parsed.code, parsed.details, body, response.headers.get("retry-after"));
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

/** Every option the CLI accepts. A free-text value that is exactly one of these is a forgotten value. */
const CLI_OPTION_NAMES = new Set([
  "--account",
  "--api-base-url",
  "--api-key",
  "--app",
  "--console-url",
  "--collection",
  "--cursor",
  "--email",
  "--expires-in-days",
  "--force",
  "--help",
  "--json",
  "--limit",
  "--message",
  "--name",
  "--no-browser",
  "--no-files",
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
  "--version",
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  if (parsed.code === "domain_pending_verification") {
    lines.push(...domainPendingLines(parsed.details));
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

/**
 * domain_pending_verification details: the domain's status, and its records with what is still
 * missing (dns_instructions), so the owner can be told which record to add.
 */
function domainPendingLines(details: unknown): string[] {
  if (!isPlainObject(details)) {
    return [];
  }
  const lines: string[] = [];
  for (const key of ["hostname", "status"]) {
    if (isPrintableScalar(details[key])) {
      lines.push(`${key}=${formatFieldValue(details[key])}`);
    }
  }
  return [...lines, ...dnsInstructionLines(details.dns_instructions)];
}

function isPrintableScalar(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
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
  for (const key of ["metric", "plan_key", "required_plan_key", "limit", "limit_key", "current", "increment", "value", "upgrade_required", "self_serve_upgrade", "upgrade_url", "support_url", "billing_url", "domain_url"]) {
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
    return "https://docs.userland.fun/reference/errors/";
  }
  if (message.includes("USERLAND_API_KEY") || message.includes("credentials")) {
    return "https://docs.userland.fun/reference/cli/";
  }
  if (message.includes("secrets") || message.includes("pending_secrets")) {
    return "https://docs.userland.fun/guides/secrets/";
  }
  if (message.includes("error=auth_disabled") || message.includes("error=invalid_role")) {
    return "https://docs.userland.fun/guides/auth/";
  }
  if (message.includes("rollback")) {
    return "https://docs.userland.fun/guides/rollback/";
  }
  return "https://docs.userland.fun/guides/troubleshooting/";
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
  userland context [--account <account-id>] [--cursor <cursor>] [--json]
  userland apps get <app-id> [--account <account-id>] [--environment <production|preview>] [--view <summary|deployments|source|resources|secrets|usage|routes|logs>] [--deployment-id <id>] [--source-revision <revision>] [--path <path>] [--cursor <cursor>] [--json]
  userland apps apply [<dir>] [--patch-json <patch> | --build-artifact <id> | --candidate-deployment <id>] [--source-revision <revision>] [--configuration-digest <digest>] --account <account-id> [--name <name>] [--app <app-id>] [--expected-revision <revision>] --environment <production|preview> --mode <publish|preview> [--audience <public|private>] [--format <source|prebuilt>] [--secret-requirements-json '<JSON array>'] --idempotency-key <key> [--json]
  userland apps apply --manifest-json '<file manifest array>' --account <account-id> [--name <name> | --app <app-id> --expected-revision <revision>] --environment <production|preview> --mode <publish|preview> --idempotency-key <key> [--format <source|prebuilt>] [--json]
  userland apps apply --account <account-id> --operation <operation-id> [--transfer-json '<part or commit object>' | --transfer-file <JSON file>] [--json]
  userland apps run <app-id> --account <account-id> --expected-revision <revision> --source-revision <source-revision> [--argv-json '<JSON string array>' | --verification-json '<named checks>'] [--deployment <preview-id>] [--evidence-paths-json '<paths>'] --idempotency-key <key> [--environment <production|preview>] [--duration-ms <1000..300000>] [--transfer-bytes <1..67108864>] [--json]
  userland apps stop <app-id> --environment <production|preview> --expected-epoch <epoch> --scope <unpublish|suspend> --idempotency-key <key> [--account <account-id>] [--json]
  userland apps resume <app-id> --environment <production|preview> --expected-epoch <epoch> --idempotency-key <key> [--account <account-id>] [--json]
  userland apps delete <app-id> --expected-revision <revision> --retention retain_source_and_data --idempotency-key <key> [--account <account-id>] [--json]
  userland resources query <app-id> --account <account-id> --environment <production|preview> --resource <resource-id> --expected-revision <revision> --expected-epoch <epoch> --statements-json '<SQL statements JSON>' --idempotency-key <key> [--json]
  userland routes set <app-id> --account <account-id> --hostname <hostname> --environment production --expected-epoch <epoch> --idempotency-key <key> [--cookie-policy <host|owned_site>] [--json]
  userland routes remove <app-id> --account <account-id> --hostname <hostname> --environment production --expected-epoch <epoch> --idempotency-key <key> [--json]
  userland apps restore <app-id> --account <account-id> --recovery <snapshot-id> [--environment preview|production] --expected-revision <revision> --expected-epoch <epoch> --idempotency-key <key> [--json]
  userland operations get <operation-id> [--account <account-id>] [--view <summary|data|evidence>] [--path <evidence-path>] [--json]
  userland operations resume <operation-id> [--account <account-id>] [--json]
  userland operations cancel <operation-id> [--account <account-id>] [--json]
  userland accounts members list [--account <account-id>] [--json]
  userland accounts members invite <email> --role <admin|member|viewer> [--account <account-id>] [--json]
  userland accounts members role <user-id> --role <admin|member|viewer> [--account <account-id>] [--json]
  userland accounts members remove <user-id> [--yes] [--account <account-id>] [--json]
  userland accounts invitations list [--json]
  userland accounts invitations accept <invitation-id> [--json]
  userland accounts invitations revoke <invitation-id> [--yes] [--account <account-id>] [--json]
  userland accounts list
  userland accounts use <account-id>
  userland apps secrets list <app-id> [--account <account-id>] [--environment <preview|production>] [--json]
  userland apps secrets set <app-id> <NAME> --environment <preview|production> --expected-revision <n> --expected-epoch <n> --expected-secret-revision <n|none> --idempotency-key <key> --source-json <json> --account <id>
  userland apps secrets set <app-id> <NAME> --operation <id> --environment <preview|production> --account <id>
  userland apps secrets delete <app-id> <NAME> --environment <preview|production> --expected-revision <n> --expected-epoch <n> --expected-secret-revision <n> --idempotency-key <key> --account <id>

Aliases:
  userland auth signup [--no-browser] [--email <email>] [--no-save]
  userland auth login [--no-browser] [--email <email>] [--no-save]
  userland api-keys list|create|rename|revoke ...


Native workflow:
  Start with context, inspect exact app/source revisions, apply an idempotent change, run checks, then poll operations.
  Builds, private browser checks, source transfer and native bindings depend on current Account capabilities.
  Source and output are untrusted app data. Secret values are entered only through protected Userland pages.
  Stop/deletion closes new execution admission but retains source and durable data; storage costs can remain.

Credentials:
  Use USERLAND_API_KEY or protected saved credentials. App operations select --account, USERLAND_ACCOUNT_ID or saved Account.
  Login uses browser device authorization. auth logout removes local credentials; --revoke also revokes that key.
  Documentation: https://docs.userland.fun/native-guide.md
`;
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

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const DEFAULT_API_BASE_URL = "https://api.userland.fun";
const DEFAULT_CONSOLE_BASE_URL = "https://console.userland.fun";
const CLI_VERSION = "0.0.0";

interface CliOptions {
  account?: string;
  app?: string;
  message?: string;
}

interface SecretSetOptions {
  account?: string;
  value?: string;
}

interface EventsOptions {
  account?: string;
  type?: string;
  severity?: string;
  releaseId?: string;
  limit?: string;
}

interface ReasonOptions {
  account?: string;
  reason?: string;
}

interface DowngradePreviewOptions {
  account?: string;
  to?: string;
}

interface RouteDisableOptions {
  reason?: string;
  status?: string;
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (isHelpCommand(command)) {
    usage(0);
  }

  if (command === "apps") {
    await appsCommand(args);
    return;
  }

  if (command === "auth") {
    await authCommand(args);
    return;
  }

  if (command === "accounts") {
    await accountsCommand(args);
    return;
  }

  if (command === "ops") {
    await opsCommand(args);
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
  if (subcommand === "secrets" && rest[0] === "set") {
    await setSecretCommand(rest.slice(1));
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

async function opsCommand(args: string[]): Promise<void> {
  const [scope, subcommand, id, actionOrFlag, ...rest] = args;
  if (scope === "accounts" && subcommand === "status" && id) {
    await printObject(await apiFetch<Record<string, unknown>>(`/v0/ops/accounts/${encodeURIComponent(id)}/status`, { method: "GET" }));
    return;
  }
  if (scope === "accounts" && subcommand === "flag" && id && actionOrFlag) {
    await printObject(await opsFlagCommand("accounts", id, actionOrFlag, rest, false));
    return;
  }
  if (scope === "accounts" && subcommand === "clear" && id && actionOrFlag) {
    await printObject(await opsFlagCommand("accounts", id, actionOrFlag, rest, true));
    return;
  }
  if (scope === "apps" && subcommand === "status" && id) {
    await printObject(await apiFetch<Record<string, unknown>>(`/v0/ops/apps/${encodeURIComponent(id)}/status`, { method: "GET" }));
    return;
  }
  if (scope === "apps" && subcommand === "flag" && id && actionOrFlag) {
    await printObject(await opsFlagCommand("apps", id, actionOrFlag, rest, false));
    return;
  }
  if (scope === "apps" && subcommand === "clear" && id && actionOrFlag) {
    await printObject(await opsFlagCommand("apps", id, actionOrFlag, rest, true));
    return;
  }
  if (scope === "apps" && subcommand === "takedown" && id) {
    const options = parseReasonOptions([actionOrFlag, ...rest].filter((value): value is string => value !== undefined));
    await printObject(await apiFetch<Record<string, unknown>>(`/v0/ops/apps/${encodeURIComponent(id)}/takedown`, {
      method: "POST",
      body: JSON.stringify(bodyWithReason(options))
    }));
    return;
  }
  if (scope === "routes" && subcommand === "disable" && id) {
    const options = parseRouteDisableOptions([actionOrFlag, ...rest].filter((value): value is string => value !== undefined));
    if (!options.status) {
      usage(1);
    }
    await printObject(await apiFetch<Record<string, unknown>>(`/v0/ops/routes/${encodeURIComponent(id)}/disable`, {
      method: "POST",
      body: JSON.stringify({ status: options.status, ...bodyWithReason(options) })
    }));
    return;
  }
  if (scope === "routes" && subcommand === "enable" && id) {
    const options = parseReasonOptions([actionOrFlag, ...rest].filter((value): value is string => value !== undefined));
    await printObject(await apiFetch<Record<string, unknown>>(`/v0/ops/routes/${encodeURIComponent(id)}/enable`, {
      method: "POST",
      body: JSON.stringify(bodyWithReason(options))
    }));
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
  const credentials = await readCredentials();
  const baseUrl = await apiBaseUrl(credentials, options.apiBaseUrl);
  const configuredConsoleUrl = await consoleBaseUrl(credentials, options.consoleUrl);
  const start = await requestJson<DeviceStartResponse>(baseUrl, "/v0/auth/device/start", {
    method: "POST",
    body: JSON.stringify({
      client: "userland-cli",
      client_version: CLI_VERSION,
      requested_capability: "api_key"
    })
  });
  const verificationUrl = options.consoleUrl
    ? `${configuredConsoleUrl.replace(/\/$/u, "")}/device?code=${encodeURIComponent(start.user_code)}`
    : start.verification_uri_complete;
  const consoleUrl = options.consoleUrl ?? consoleUrlFromVerification(start.verification_uri, configuredConsoleUrl);

  if (context.signupAlias) {
    console.log("Signup uses the same browser approval flow as login. New accounts are created in the browser after email proof.");
  }
  if (options.email) {
    console.log(`email_hint=${options.email}`);
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
  console.log(`user_code=${start.user_code}`);
  console.log("Waiting for approval...");

  const response = await pollDeviceAuthorization(baseUrl, start);

  if (options.save !== false) {
    const filePath = await saveCredentials({
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

async function authStatusCommand(): Promise<void> {
  const credentials = await readCredentials();
  const filePath = credentialsPath();
  const apiKeySource = process.env.USERLAND_API_KEY ? "env" : credentials?.api_key ? "file" : "missing";
  const selectedAccountId = process.env.USERLAND_ACCOUNT_ID ?? credentials?.account_id;
  const accountSource = process.env.USERLAND_ACCOUNT_ID ? "env" : credentials?.account_id ? "file" : apiKeySource === "missing" ? "missing" : "default";
  console.log(`api_base_url=${await apiBaseUrl(credentials)}`);
  console.log(`console_url=${await consoleBaseUrl(credentials)}`);
  console.log(`api_key=${apiKeySource}`);
  console.log(`credentials_file=${filePath}`);
  if (apiKeySource === "file" && credentials?.api_key_id) {
    console.log(`api_key_id=${credentials.api_key_id}`);
  }
  console.log(`account=${accountSource}`);
  if (selectedAccountId) {
    console.log(`account_id=${selectedAccountId}`);
  }
  if (apiKeySource === "file" && credentials?.username) {
    console.log(`username=${credentials.username}`);
  }
}

async function saveKeyCommand(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  const apiKey = options.apiKey ?? (await promptRequired("API key: "));
  const credentials = await readCredentials();
  const filePath = await saveCredentials({
    api_key: apiKey,
    api_key_id: null,
    api_base_url: await apiBaseUrl(credentials, options.apiBaseUrl),
    console_url: await consoleBaseUrl(credentials, options.consoleUrl),
    username: null,
    account_id: options.account ?? null
  });
  console.log(`Saved API key to ${filePath}`);
  if (options.account) {
    console.log(`selected_account_id=${options.account}`);
  }
}

async function logoutCommand(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  const credentials = await readCredentials();
  const filePath = credentialsPath();
  if (options.revoke) {
    if (credentials?.api_key && credentials.api_key_id) {
      await requestJson<ApiKeyRevokeResponse>(
        await apiBaseUrl(credentials, options.apiBaseUrl),
        `/v0/auth/api-keys/${encodeURIComponent(credentials.api_key_id)}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${credentials.api_key}`
          }
        }
      );
      console.log(`revoked_api_key_id=${credentials.api_key_id}`);
    } else {
      console.log("revoke=skipped api_key_id_missing");
    }
  }
  await fs.rm(filePath, { force: true });
  console.log("local_credentials=removed");
  console.log(`credentials_file=${filePath}`);
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
  const response = await apiFetch<AccountStatusResponse>(`/v0/accounts/${encodeURIComponent(accountId)}/status`, {
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
  const response = await apiFetch<AccountLimitsResponse>(`/v0/accounts/${encodeURIComponent(accountId)}/limits`, {
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
  const accountId = await resolveAccountId(options.account);
  const params = new URLSearchParams({ plan: options.to });
  const response = await apiFetch<DowngradePreviewResponse>(`/v0/accounts/${encodeURIComponent(accountId)}/downgrade-preview?${params.toString()}`, {
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

  const response = await apiFetch<VersionResponse>(`/v0/apps/${appId}/releases`, {
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

  const response = await apiFetch<RollbackResponse>(`/v0/apps/${appId}/rollback`, {
    method: "POST",
    body: JSON.stringify({ release_id: releaseId })
  }, { accountId: options.account, accountScoped: true });

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
  }, { accountId: options.account, accountScoped: true });

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
  const response = await apiFetch<AppStatusResponse>(`/v0/apps/${encodeURIComponent(appId)}`, {
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
  const response = await apiFetch<RoutesResponse>(`/v0/apps/${encodeURIComponent(appId)}/routes`, {
    method: "GET"
  }, { accountId: options.account, accountScoped: true });
  printRoutes(response.routes);
}

async function appSlugsCommand(args: string[]): Promise<void> {
  const [action, appId, slug, ...optionArgs] = args;
  if (action === "list" && appId) {
    const options = parseAccountOptions([slug, ...optionArgs].filter((value): value is string => value !== undefined));
    const response = await apiFetch<RoutesResponse>(`/v0/apps/${encodeURIComponent(appId)}/slugs`, {
      method: "GET"
    }, { accountId: options.account, accountScoped: true });
    printRoutes(response.routes);
    return;
  }
  if (action === "add" && appId && slug) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${encodeURIComponent(appId)}/slugs`, {
      method: "POST",
      body: JSON.stringify({ slug })
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  if (action === "remove" && appId && slug) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${encodeURIComponent(appId)}/slugs/${encodeURIComponent(slug)}`, {
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
    const response = await apiFetch<RoutesResponse>(`/v0/apps/${encodeURIComponent(appId)}/domains`, {
      method: "GET"
    }, { accountId: options.account, accountScoped: true });
    printRoutes(response.routes);
    return;
  }
  if (action === "add" && appId && hostname) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${encodeURIComponent(appId)}/domains`, {
      method: "POST",
      body: JSON.stringify({ hostname })
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  if (action === "verify" && appId && hostname) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${encodeURIComponent(appId)}/domains/${encodeURIComponent(hostname)}/verify`, {
      method: "POST",
      body: JSON.stringify({})
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  if (action === "remove" && appId && hostname) {
    const options = parseAccountOptions(optionArgs);
    const response = await apiFetch<RouteResponse>(`/v0/apps/${encodeURIComponent(appId)}/domains/${encodeURIComponent(hostname)}`, {
      method: "DELETE"
    }, { accountId: options.account, accountScoped: true });
    printRoute(response.route);
    return;
  }
  usage(1);
}

async function opsFlagCommand(scope: "accounts" | "apps", id: string, flag: string, args: string[], clear: boolean): Promise<Record<string, unknown>> {
  const options = parseReasonOptions(args);
  return await apiFetch<Record<string, unknown>>(`/v0/ops/${scope}/${encodeURIComponent(id)}/flags/${encodeURIComponent(flag)}${clear ? "/clear" : ""}`, {
    method: clear ? "POST" : "PUT",
    body: JSON.stringify(bodyWithReason(options))
  });
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

function bodyWithReason(options: { reason?: string }): Record<string, string> {
  return options.reason ? { reason: options.reason } : {};
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

async function apiFetch<T>(apiPath: string, init: RequestInit, options: { accountId?: string; accountScoped?: boolean } = {}): Promise<T> {
  const credentials = await readCredentials();
  const apiKey = process.env.USERLAND_API_KEY ?? credentials?.api_key;
  if (!apiKey) {
    throw new Error("USERLAND_API_KEY is required. Run `userland signup` or `userland login` to save credentials.");
  }

  const baseUrl = await apiBaseUrl(credentials);
  const accountId = options.accountScoped ? selectedAccountId(options.accountId, credentials) : undefined;
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    ...(init.headers as Record<string, string> | undefined)
  };
  if (accountId) {
    headers["x-userland-account-id"] = accountId;
  }
  return await requestJson<T>(baseUrl, apiPath, {
    ...init,
    headers
  });
}

function selectedAccountId(explicitAccountId: string | undefined, credentials: CredentialsFile | undefined): string | undefined {
  return explicitAccountId ?? process.env.USERLAND_ACCOUNT_ID ?? credentials?.account_id;
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
  const response = await fetch(`${baseUrl.replace(/\/$/u, "")}${apiPath}`, {
    ...init,
    headers: {
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

async function apiBaseUrl(credentials?: CredentialsFile, override?: string): Promise<string> {
  return override ?? process.env.USERLAND_API_BASE_URL ?? credentials?.api_base_url ?? (await readCredentials())?.api_base_url ?? DEFAULT_API_BASE_URL;
}

async function consoleBaseUrl(credentials?: CredentialsFile, override?: string): Promise<string> {
  return override ?? process.env.USERLAND_CONSOLE_URL ?? credentials?.console_url ?? (await readCredentials())?.console_url ?? DEFAULT_CONSOLE_BASE_URL;
}

function consoleUrlFromVerification(verificationUri: string | undefined, fallback: string): string {
  if (!verificationUri) {
    return fallback;
  }
  try {
    const url = new URL(verificationUri);
    return `${url.origin}`;
  } catch {
    return fallback;
  }
}

async function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
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
  return process.env.USERLAND_CREDENTIALS_FILE ?? path.join(os.homedir(), ".userland", "credentials.json");
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

  const parsed: unknown = JSON.parse(contents);
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

async function saveCredentials(update: CredentialsUpdate): Promise<string> {
  const filePath = credentialsPath();
  const existing = (await readCredentials()) ?? {};
  const sanitizedUpdate = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) as CredentialsFile;
  const credentials: CredentialsFile = {
    ...existing,
    ...sanitizedUpdate,
    updated_at: new Date().toISOString()
  };
  for (const [key, value] of Object.entries(update)) {
    if (value === null) {
      delete credentials[key as keyof CredentialsFile];
    }
  }

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  return filePath;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--app") {
      options.app = args[++index];
    } else if (arg === "--message") {
      options.message = args[++index];
    } else if (arg === "--account") {
      options.account = args[++index];
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
      options.email = args[++index];
    } else if (arg === "--api-key") {
      options.apiKey = args[++index];
    } else if (arg === "--no-save") {
      options.save = false;
    } else if (arg === "--save=false") {
      options.save = false;
    } else if (arg === "--no-browser") {
      options.noBrowser = true;
    } else if (arg === "--api-base-url") {
      options.apiBaseUrl = args[++index];
    } else if (arg === "--console-url") {
      options.consoleUrl = args[++index];
    } else if (arg === "--account") {
      options.account = args[++index];
    } else if (arg === "--revoke") {
      options.revoke = true;
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
    } else if (arg === "--account") {
      options.account = args[++index];
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
    } else if (arg === "--account") {
      options.account = args[++index];
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
      options.to = args[++index];
    } else if (arg === "--account") {
      options.account = args[++index];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseReasonOptions(args: string[]): ReasonOptions {
  const options: ReasonOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reason") {
      options.reason = args[++index];
    } else if (arg === "--account") {
      options.account = args[++index];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseRouteDisableOptions(args: string[]): RouteDisableOptions {
  const options: RouteDisableOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--status") {
      options.status = args[++index];
    } else if (arg === "--reason") {
      options.reason = args[++index];
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
      options.account = args[++index];
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

async function promptRequired(prompt: string): Promise<string> {
  const value = await promptLine(prompt);
  if (!value) {
    throw new Error(`${prompt.replace(/:\s*$/u, "")} is required.`);
  }
  return value;
}

async function promptLine(prompt: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(prompt)).trim();
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
  return lines.filter(Boolean).join("\n");
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
  for (const key of ["metric", "plan_key", "required_plan_key", "limit", "limit_key", "current", "increment", "value", "upgrade_required"]) {
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
  if (message.includes("entitlement_required") || message.includes("plan_limit_exceeded") || message.includes("quota_exceeded") || message.includes("downgrade_incompatible")) {
    return "https://docs.userland.fun/reference/errors";
  }
  if (message.includes("USERLAND_API_KEY") || message.includes("credentials")) {
    return "https://docs.userland.fun/reference/cli";
  }
  if (message.includes("secrets") || message.includes("pending_secrets")) {
    return "https://docs.userland.fun/guides/secrets";
  }
  if (message.includes("rollback")) {
    return "https://docs.userland.fun/guides/rollback";
  }
  return "https://docs.userland.fun/guides/troubleshooting";
}

function isHelpCommand(command: string | undefined): boolean {
  return command === "--help" || command === "-h" || command === "help";
}

function usage(exitCode: number): never {
  const message = `Usage:
  userland [--help]
  userland signup [--no-browser] [--email <email>] [--api-base-url <url>] [--console-url <url>] [--no-save]
  userland login [--no-browser] [--email <email>] [--api-base-url <url>] [--console-url <url>] [--no-save]
  userland auth status
  userland auth save-key --api-key <api-key> [--account <account-id>] [--api-base-url <url>] [--console-url <url>]
  userland auth logout [--revoke]
  userland accounts list
  userland accounts use <account-id>
  userland accounts status [--account <account-id>]
  userland accounts limits [--account <account-id>]
  userland accounts downgrade preview --to <plan> [--account <account-id>]
  userland apps publish <dir> [--app <app-id>] [--message <message>] [--account <account-id>]
  userland apps list [--account <account-id>]
  userland apps status <app-id> [--account <account-id>]
  userland apps releases <app-id> [--account <account-id>]
  userland apps rollback <app-id> <release-id> [--account <account-id>]
  userland apps secrets set <app-id> <NAME> [--value <value>] [--account <account-id>]
  userland apps events <app-id> [--type <event-type>] [--severity <level>] [--release <release-id>] [--limit <n>] [--account <account-id>]
  userland apps routes list <app-id> [--account <account-id>]
  userland apps slugs list <app-id> [--account <account-id>]
  userland apps slugs add <app-id> <slug> [--account <account-id>]
  userland apps slugs remove <app-id> <slug> [--account <account-id>]
  userland apps domains list <app-id> [--account <account-id>]
  userland apps domains add <app-id> <hostname> [--account <account-id>]
  userland apps domains verify <app-id> <hostname> [--account <account-id>]
  userland apps domains remove <app-id> <hostname> [--account <account-id>]
  userland ops accounts status <account-id>
  userland ops accounts flag <account-id> <flag> [--reason <text>]
  userland ops accounts clear <account-id> <flag> [--reason <text>]
  userland ops apps status <app-id>
  userland ops apps flag <app-id> <flag> [--reason <text>]
  userland ops apps clear <app-id> <flag> [--reason <text>]
  userland ops apps takedown <app-id> [--reason <text>]
  userland ops routes disable <route-id> --status <disabled_abuse|disabled_billing|disabled_downgrade> [--reason <text>]
  userland ops routes enable <route-id> [--reason <text>]

Aliases:
  userland auth signup [--no-browser] [--email <email>] [--no-save]
  userland auth login [--no-browser] [--email <email>] [--no-save]
  userland publish <dir> [--app <app-id>] [--message <message>] [--account <account-id>]
  userland releases <app-id> [--account <account-id>]
  userland versions <app-id> [--account <account-id>]

Credentials:
  Commands use USERLAND_API_KEY first, then ~/.userland/credentials.json for API keys.
  App commands use --account, then USERLAND_ACCOUNT_ID, then saved account_id when set.
  Login and signup use browser device authorization and save only API-key credentials locally.

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
  console.error(message);
  console.error(`Docs: ${docsUrlForError(message)}`);
  process.exit(1);
});

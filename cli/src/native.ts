import { readNativePackage } from "./nativePackage.js";

export interface NativeClient {
  apiFetch<T>(apiPath: string, init: RequestInit, options?: { accountId?: string; accountScoped?: boolean; raw?: boolean }): Promise<T>;
  pathSegment(value: string, label: string): string;
  print(text: string): void;
}
interface Options { positional: string[]; json?: boolean; values: Record<string, string> }

/** Native commands share one direct API contract; applying an already authorized intent has no extra Publish step. */
export async function nativeCommand(command: string, args: string[], client: NativeClient): Promise<void> {
  const action = command === "context" ? "context" : args[0];
  const rest = command === "context" ? args : args.slice(1);
  const getApp = command === "apps" && action === "get", apply = command === "apps" && action === "apply";
  const operation = command === "operations" && ["get", "resume", "cancel"].includes(action);
  if (action !== "context" && !getApp && !apply && !operation) throw new Error("Use context, apps get|apply, or operations get|resume|cancel. apps.run is not available in the current profile.");
  const allowed = apply ? ["account", "name", "app", "expected-revision", "environment", "mode", "audience", "idempotency-key"] : getApp ? ["account", "environment", "view", "source-revision", "path", "cursor"] : action === "context" ? ["account", "cursor"] : ["account"];
  const options = parseOptions(rest, allowed), values = options.values;
  if (options.positional.length !== (action === "context" ? 0 : 1)) throw new Error(action === "context" ? "context takes flags, not a positional argument." : "Pass exactly one prebuilt directory, app ID or operation ID.");
  let apiPath: string, method: "GET" | "POST" = "GET", body: string | undefined;
  const params = new URLSearchParams();
  if (action === "context") { apiPath = "/v1/context"; if (values.cursor) params.set("cursor", values.cursor); }
  else if (getApp) {
    apiPath = `/v1/apps/${client.pathSegment(options.positional[0], "app ID")}`;
    for (const name of ["environment", "view", "source-revision", "path", "cursor"]) if (values[name]) params.set(name.replaceAll("-", "_"), values[name]);
  } else if (apply) {
    if (!values.account) throw new Error("--account is required. Start with userland context to choose the Account explicitly.");
    if (Boolean(values.name) === Boolean(values.app)) throw new Error("Choose exactly one of --name (create) or --app (update).");
    if (!values["idempotency-key"] || values["idempotency-key"].length > 128) throw new Error("--idempotency-key is required, at most 128 characters. Reuse the exact key for retries of this intent.");
    if (!["production", "preview"].includes(values.environment ?? "") || !["publish", "preview"].includes(values.mode ?? "")) throw new Error("Use explicit --environment production|preview and --mode publish|preview.");
    if (values.audience && !["public", "private"].includes(values.audience)) throw new Error("--audience must be public or private.");
    let app: { create: { name: string } } | { id: string; expected_revision: number };
    if (values.app) {
      const revision = values["expected-revision"];
      if (!revision || !/^(?:0|[1-9]\d*)$/u.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error("Updates require --expected-revision with the exact app revision read through apps get.");
      app = { id: values.app, expected_revision: Number(revision) };
    } else {
      if (values["expected-revision"] !== undefined) throw new Error("--expected-revision is only used with --app.");
      app = { create: { name: values.name } };
    }
    const source = await readNativePackage(options.positional[0]);
    body = JSON.stringify({ account_id: values.account, app, source, target: { environment: values.environment, mode: values.mode, ...(values.audience ? { audience: values.audience } : {}) }, idempotency_key: values["idempotency-key"] });
    if (Buffer.byteLength(body, "utf8") > 768 * 1024) throw new Error("The encoded native request exceeds 768 KiB; reduce the prebuilt package. Decoded source is capped separately at 512 KiB.");
    apiPath = "/v1/apps/apply"; method = "POST";
  } else {
    apiPath = `/v1/operations/${client.pathSegment(options.positional[0], "operation ID")}${action === "get" ? "" : `/${action}`}`;
    if (action !== "get") method = "POST";
  }
  if (params.size) apiPath += `?${params}`;
  const result = await client.apiFetch<unknown>(apiPath, { method, ...(body ? { body } : {}) }, { accountId: values.account, accountScoped: true, raw: options.json === true });
  client.print(JSON.stringify(result, null, 2));
}
function parseOptions(args: string[], allowed: string[]): Options {
  const options: Options = { positional: [], values: {} };
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === "--json") { options.json = true; continue; }
    if (item.startsWith("--") && allowed.includes(item.slice(2))) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${item} requires a value.`);
      options.values[item.slice(2)] = value; continue;
    }
    if (item.startsWith("-")) throw new Error(`Unknown option ${item}. See userland --help.`);
    options.positional.push(item);
  }
  return options;
}

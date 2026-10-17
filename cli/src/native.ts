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
  const run = command === "apps" && action === "run";
  const lifecycle = command === "apps" && ["stop", "resume", "delete"].includes(action);
  const operation = command === "operations" && ["get", "resume", "cancel"].includes(action);
  if (action !== "context" && !getApp && !apply && !run && !operation && !lifecycle) throw new Error("Use context, apps get|apply|run|stop|resume|delete, or operations get|resume|cancel.");
  const allowed = apply ? ["account", "name", "app", "expected-revision", "environment", "mode", "audience", "format", "secret-requirements-json", "patch-json", "build-artifact", "candidate-deployment", "source-revision", "configuration-digest", "idempotency-key"] : run ? ["account", "expected-revision", "source-revision", "argv-json", "deployment", "evidence-paths-json", "environment", "duration-ms", "transfer-bytes", "idempotency-key"] : lifecycle ? action === "delete" ? ["account", "expected-revision", "retention", "idempotency-key"] : ["account", "environment", "expected-epoch", "idempotency-key", ...(action === "stop" ? ["scope"] : [])] : getApp ? ["account", "environment", "view", "source-revision", "path", "cursor"] : action === "context" ? ["account", "cursor"] : operation && action === "get" ? ["account", "view", "path"] : ["account"];
  const options = parseOptions(rest, allowed), values = options.values;
  if (options.positional.length !== (action === "context" || apply && (values["patch-json"] || values["build-artifact"] || values["candidate-deployment"]) ? 0 : 1)) throw new Error(action === "context" ? "context takes flags, not a positional argument." : "Pass exactly one prebuilt directory, app ID or operation ID.");
  let apiPath: string, method: "GET" | "POST" | "DELETE" = "GET", body: string | undefined;
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
      if (!revision || !/^[1-9]\d*$/u.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error("Updates require --expected-revision with the exact app revision read through apps get.");
      app = { id: values.app, expected_revision: Number(revision) };
    } else {
      if (values["expected-revision"] !== undefined) throw new Error("--expected-revision is only used with --app.");
      app = { create: { name: values.name } };
    }
    const promoted = Boolean(values["build-artifact"] || values["candidate-deployment"]);
    if ((promoted || values["patch-json"]) && !values.app) throw new Error("Patching and promotion require --app and its current revision.");
    if (promoted && (values["patch-json"] || values.format || values["secret-requirements-json"] || Boolean(values["build-artifact"]) === Boolean(values["candidate-deployment"]))) throw new Error("Choose exactly one artifact or candidate; promotion cannot replace source, format or secret requirements.");
    let source: unknown;
    if (values["patch-json"]) {
      try { source = JSON.parse(values["patch-json"]); } catch { throw new Error("--patch-json must contain an atomic source patch object."); }
      const patch = source as { base_source_revision?: unknown; changes?: unknown[]; format?: unknown };
      if (!patch || typeof patch !== "object" || !/^src_(?:sha256:v1:)?[a-f0-9]{64}$/u.test(String(patch.base_source_revision)) || !Array.isArray(patch.changes) || !patch.changes.length || patch.changes.length > 128) throw new Error("--patch-json requires an exact base_source_revision and one to 128 changes.");
      if (values.format) source = { ...patch, format: values.format };
    } else if (!promoted) source = { ...await readNativePackage(options.positional[0]), ...(values.format ? { format: values.format } : {}) };
    if (promoted && (!/^src_(?:sha256:v1:)?[a-f0-9]{64}$/u.test(values["source-revision"] ?? "") || !/^(?:sha256:v1:)?[a-f0-9]{64}$/u.test(values["configuration-digest"] ?? ""))) throw new Error("Promotion requires exact --source-revision and --configuration-digest assertions.");
    if (!promoted && (values["source-revision"] || values["configuration-digest"])) throw new Error("Source and configuration assertions apply only to artifact promotion.");
    if (values.format && !["source", "prebuilt"].includes(values.format)) throw new Error("--format must be source or prebuilt.");
    let secrets: unknown;
    if (values["secret-requirements-json"]) {
      try { secrets = JSON.parse(values["secret-requirements-json"]); } catch { throw new Error("--secret-requirements-json must be a JSON array."); }
      if (!Array.isArray(secrets) || secrets.length > 16 || secrets.some(item => !item || typeof item !== "object" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(item.name) || (item.ensure === "external" ? Object.keys(item).some(key=>!["name","ensure","provider","purpose"].includes(key)) || typeof item.provider!=="string" || !item.provider.trim() || typeof item.purpose!=="string" || !item.purpose.trim() : Object.keys(item).some(key => !["name", "ensure", "bytes"].includes(key)) || item.ensure !== "generated" || !Number.isInteger(item.bytes) || item.bytes < 16 || item.bytes > 64))) throw new Error("Use at most sixteen generated secret requirements (name, ensure, bytes) or external requirements (name, ensure, provider, purpose).");
    }
    body = JSON.stringify({ account_id: values.account, app, ...(promoted ? { ...(values["build-artifact"] ? { build_artifact_id: values["build-artifact"] } : { candidate_deployment_id: values["candidate-deployment"] }), source_revision: values["source-revision"], configuration_digest: values["configuration-digest"] } : { source }), ...(secrets !== undefined ? { secret_requirements: secrets } : {}), target: { environment: values.environment, mode: values.mode, ...(values.audience ? { audience: values.audience } : {}) }, idempotency_key: values["idempotency-key"] });
    if (Buffer.byteLength(body, "utf8") > 768 * 1024) throw new Error("The encoded native request exceeds 768 KiB; reduce the prebuilt package. Decoded source is capped separately at 512 KiB.");
    apiPath = "/v1/apps/apply"; method = "POST";
  } else if (run) {
    if (!values.account) throw new Error("--account is required. Start with userland context to choose the Account explicitly.");
    const revision = values["expected-revision"];
    if (!revision || !/^[1-9]\d*$/u.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error("--expected-revision must be the current positive app revision from apps get.");
    if (!/^src_(?:sha256:v1:)?[a-f0-9]{64}$/u.test(values["source-revision"] ?? "")) throw new Error("--source-revision must identify exact saved source; moving selectors are not supported.");
    if (!values["idempotency-key"] || values["idempotency-key"].length > 128) throw new Error("--idempotency-key is required, at most 128 characters. Reuse the exact key for retries.");
    let argv: unknown;
    try { argv = JSON.parse(values["argv-json"] ?? ""); } catch { throw new Error("--argv-json must be a JSON array of literal command arguments."); }
    if (!Array.isArray(argv) || !argv.length || argv.length > 64 || !argv[0] || argv.some(value => typeof value !== "string" || value.length > 4096 || value.includes("\0")) || Buffer.byteLength(JSON.stringify(argv)) > 32 * 1024) throw new Error("--argv-json must contain one to 64 bounded literal string arguments.");
    if (values.environment && !["production", "preview"].includes(values.environment)) throw new Error("--environment must be production or preview.");
    let task: { kind: string; argv: string[]; deployment_id?: string; evidence_paths?: string[] } = { kind: "command", argv: argv as string[] };
    if (values["evidence-paths-json"] && !values.deployment) throw new Error("--evidence-paths-json requires --deployment for an exact private preview browser task.");
    if (values.deployment) {
      if (!/^dep_[A-Za-z0-9_-]+$/u.test(values.deployment)) throw new Error("--deployment must be an exact preview deployment ID.");
      if (values.environment && values.environment !== "preview") throw new Error("Browser tasks require --environment preview.");
      let paths: unknown = [];
      if (values["evidence-paths-json"]) { try { paths = JSON.parse(values["evidence-paths-json"]); } catch { throw new Error("--evidence-paths-json must be a JSON array."); } }
      if (!Array.isArray(paths) || paths.length > 8 || new Set(paths).size !== paths.length || paths.some(path => typeof path !== "string" || !path || path.length > 200 || path.startsWith("/") || /[\\\u0000-\u001f%?#]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || !/\.(?:png|zip)$/u.test(path))) throw new Error("Declare at most eight unique relative PNG or ZIP evidence paths.");
      task = { kind: "browser", argv: argv as string[], deployment_id: values.deployment, ...(paths.length ? { evidence_paths: paths } : {}) };
    }
    const limits: Record<string, number> = {};
    for (const [flag, field, minimum, maximum] of [["duration-ms", "duration_ms", 1000, 300000], ["transfer-bytes", "transfer_bytes", 1, 67108864]] as const) {
      if (values[flag] === undefined) continue;
      const number = Number(values[flag]);
      if (!/^\d+$/u.test(values[flag]) || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`--${flag} must be between ${minimum} and ${maximum}.`);
      limits[field] = number;
    }
    apiPath = `/v1/apps/${client.pathSegment(options.positional[0], "app ID")}/runs`; method = "POST";
    body = JSON.stringify({ account_id: values.account, expected_revision: Number(revision), source: { source_revision: values["source-revision"] }, task, ...(values.environment ? { environment: values.environment } : {}), ...(Object.keys(limits).length ? { limits } : {}), idempotency_key: values["idempotency-key"] });
  } else if (lifecycle) {
    if (!values["idempotency-key"] || values["idempotency-key"].length > 128) throw new Error("--idempotency-key is required, at most 128 characters. Reuse the exact key for retries.");
    const numberFlag = action === "delete" ? "expected-revision" : "expected-epoch";
    const current = values[numberFlag];
    if (!current || !/^[1-9]\d*$/u.test(current) || !Number.isSafeInteger(Number(current))) throw new Error(`--${numberFlag} must be the current positive integer from apps get.`);
    const intent: Record<string, unknown> = { idempotency_key: values["idempotency-key"] };
    if (action === "delete") {
      if (values.retention !== "retain_source_and_data") throw new Error("Execution deletion requires --retention retain_source_and_data. Data purge is not supported.");
      intent.expected_revision = Number(current); intent.retention = values.retention;
    } else {
      if (!["production", "preview"].includes(values.environment ?? "")) throw new Error("Choose --environment production|preview explicitly.");
      intent.environment = values.environment; intent.expected_epoch = Number(current);
      if (action === "stop") {
        if (!["unpublish", "suspend"].includes(values.scope ?? "")) throw new Error("Choose --scope unpublish|suspend explicitly.");
        intent.scope = values.scope;
      }
    }
    apiPath = `/v1/apps/${client.pathSegment(options.positional[0], "app ID")}${action === "delete" ? "" : `/${action}`}`;
    method = action === "delete" ? "DELETE" : "POST"; body = JSON.stringify(intent);
  } else {
    apiPath = `/v1/operations/${client.pathSegment(options.positional[0], "operation ID")}${action === "get" ? "" : `/${action}`}`;
    if (action !== "get") method = "POST";
    else {
      if (values.view && !["summary", "evidence"].includes(values.view)) throw new Error("--view must be summary or evidence.");
      if ((values.view === "evidence") !== Boolean(values.path)) throw new Error("Use --view evidence with one exact --path.");
      for (const name of ["view", "path"]) if (values[name]) params.set(name, values[name]);
    }
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

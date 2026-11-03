import type { NativeClient } from "./native.js";

/** Snapshot commands return metadata only; archive bytes stay on the signed-in console. */
export async function nativeRecoveryCommand(command: string, args: string[], client: NativeClient): Promise<void> {
  const action = args[0];
  const snapshot = command === "apps" && action === "snapshot";
  if (!snapshot && !(command === "recoveries" && ["list", "get", "resume", "cancel"].includes(action))) {
    throw new Error("Use apps snapshot or recoveries list|get|resume|cancel.");
  }
  const allowed = snapshot
    ? ["account", "environment", "resources-json", "expected-revision", "expected-epoch", "idempotency-key"]
    : ["account"];
  const values: Record<string, string> = {}, positional: string[] = [];
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const item = args[index];
    if (item === "--json") { json = true; continue; }
    if (item.startsWith("--")) {
      const name = item.slice(2), value = args[++index];
      if (!allowed.includes(name) || !value || value.startsWith("--") || values[name] !== undefined) throw new Error(`Invalid or duplicate ${item}.`);
      values[name] = value;
    } else if (item.startsWith("-")) throw new Error(`Unknown option ${item}. See userland --help.`);
    else positional.push(item);
  }
  if (positional.length !== 1) throw new Error(snapshot || action === "list" ? "Pass one exact app ID." : "Pass one exact recovery ID.");
  for (const name of allowed) if (!values[name]) throw new Error(`--${name} is required.`);

  let apiPath: string, method: "GET" | "POST" = "GET", body: string | undefined;
  if (snapshot || action === "list") {
    apiPath = `/v1/apps/${client.pathSegment(positional[0], "app ID")}/recoveries`;
    if (snapshot) {
      if (!["production", "preview"].includes(values.environment)) throw new Error("--environment must be production or preview.");
      for (const name of ["expected-revision", "expected-epoch"]) {
        if (!/^[1-9]\d*$/u.test(values[name]) || !Number.isSafeInteger(Number(values[name]))) throw new Error(`--${name} must be the exact current positive integer from apps get.`);
      }
      if (values["idempotency-key"].length > 128) throw new Error("--idempotency-key is at most 128 characters; reuse it only for this intent.");
      let resources: unknown;
      try { resources = JSON.parse(values["resources-json"]); } catch { throw new Error("--resources-json must be a JSON array of exact owned resource IDs."); }
      if (!Array.isArray(resources) || resources.length < 1 || resources.length > 4 || new Set(resources).size !== resources.length || resources.some(id => typeof id !== "string" || !id.trim() || id.length > 128)) {
        throw new Error("--resources-json must contain one to four unique owned resource IDs, each at most 128 characters.");
      }
      body = JSON.stringify({ account_id: values.account, environment: values.environment, resource_ids: resources, expected_revision: Number(values["expected-revision"]), expected_epoch: Number(values["expected-epoch"]), idempotency_key: values["idempotency-key"] });
      method = "POST";
    }
  } else {
    apiPath = `/v1/recoveries/${client.pathSegment(positional[0], "recovery ID")}${action === "get" ? "" : `/${action}`}`;
    if (action !== "get") method = "POST";
  }
  const result = await client.apiFetch(apiPath, { method, ...(body ? { body } : {}) }, { accountId: values.account, accountScoped: true, raw: json });
  client.print(JSON.stringify(result, null, 2));
}

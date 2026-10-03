import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { terminalSafe } from "./terminal.js";

// Local, offline validation for `userland validate` and the `apps publish` preflight.
// The Userland API stays authoritative: these checks mirror the public manifest schema
// (schemas/resource-manifest-v0.schema.json) and the public plan artifact
// (schemas/plans-v0.json, generated from the API's plan configuration) so agents get
// fast feedback before uploading anything.

export type PlanKey = string;
export type ManifestLimitValue = number | null | string[];

export interface PlanEntry {
  display_name: string;
  features: Record<string, boolean>;
  manifest_limits: Record<string, ManifestLimitValue>;
  release_limits: Record<string, number | null>;
}

export interface PlanData {
  version: number;
  plan_order: PlanKey[];
  plan_aliases: Record<string, PlanKey>;
  bundle_limits: {
    "files.max": number;
    "file_bytes.max": number;
    "bundle_bytes.max": number;
  };
  plans: Record<PlanKey, PlanEntry>;
}

/** Features and limits to check against, from the plan table or an account's `/limits` response. */
export interface EntitlementConfig {
  features: Record<string, boolean>;
  manifest_limits: Record<string, ManifestLimitValue>;
  release_limits?: Record<string, number | null>;
}

export interface Requirement {
  kind: "feature" | "limit" | "schedule" | "release";
  key: string;
  manifest_path: string;
  value: unknown;
}

export interface ValidationFinding {
  kind: "manifest_feature" | "manifest_limit" | "release_limit";
  manifest_path: string;
  feature_key?: string;
  limit_key?: string;
  value: unknown;
  allowed: boolean | number | string[] | null;
  plan_key: PlanKey;
  /** Lowest self-serve plan that allows the value, or SUPPORT_ONLY_PLAN_KEY ("internal") when none does. */
  required_plan_key: PlanKey;
  message: string;
}

export interface ValidationIssue {
  code: string;
  manifest_path: string;
  /** Release file path, for file-level problems. */
  file?: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  plan: PlanKey | null;
  plan_source: "flag" | "account" | null;
  required_plan_key: PlanKey | null;
  violations: ValidationFinding[];
  plan_gated: ValidationFinding[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  manifest_file: string | null;
  release: {
    file_count: number;
    bundle_bytes: number;
  };
  /**
   * The other sites allowed to show the app in a frame (runtime.embed_origins), as the API stores
   * them: lowercase, without repeats. Empty when none are listed; null when manifest errors prevent
   * the check.
   */
  embed_origins: string[] | null;
}

export interface ValidateOptions {
  /** Treat schema-only strictness the API tolerates (code schema_strict) as errors. */
  strict?: boolean;
  planKey?: PlanKey;
  planSource?: "flag" | "account";
  /** Effective account entitlements; defaults to the public plan table entry for planKey. */
  entitlements?: EntitlementConfig;
}

/** Plan-independent result of reading an app directory; apply a plan with applyPlan. */
export interface AppAnalysis {
  report: ValidationReport;
  /** Plan requirements, or null when manifest errors prevent the analysis. */
  requirements: Requirement[] | null;
}

export interface ReleaseFileEntry {
  path: string;
  absolutePath: string;
  contentType?: string;
}

export interface ManifestInput {
  app: Record<string, unknown>;
  runtime: Record<string, unknown>;
  resources: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

const MANIFEST_FILE = "manifest.userland.json";
const LEGACY_MANIFEST_FILE = "manifest.json";
// Top-level keys the CLI reads itself (never sent to the API as manifest fields). `$schema`
// is the editor hint for schemas/resource-manifest-v0.schema.json and is ignored.
const CLI_MANIFEST_KEYS = new Set(["$schema", "files", "message", "provenance"]);
// A top-level manifest.json is read as the (older) Userland manifest only when it has one of these keys.
const USERLAND_MANIFEST_KEYS = ["app", "runtime", "resources", "files"];
// Dot-folders a directory publish still includes: /.well-known/ URLs are part of the web.
const ALLOWED_DOT_DIRECTORIES = new Set([".well-known"]);
const PRIVATE_KEY_NAME = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/u;
const KEY_STORE_EXTENSIONS = new Set([".p12", ".pfx"]);
const PEM_EXTENSIONS = new Set([".pem", ".key"]);
const RESERVED_RESOURCE_NAMES = new Set(["_userland", "system", "auth", "session", "sessions", "secrets", "runtime"]);
// The API's rule (packages/shared CONTENT_TYPE_PATTERN): parameters separated by spaces or tabs only, and
// quoted values of printable ASCII without `"`, `\` or `,`, which browsers read differently.
const CONTENT_TYPE_PATTERN =
  /^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+(?:[\t ]*;[\t ]*[!#$%&'*+\-.^_`|~0-9a-z]+=(?:"[\t\x20\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]*"|[!#$%&'*+\-.^_`|~0-9a-z]+))*$/iu;

let cachedManifestSchema: JsonSchema | undefined;
let cachedPlanData: PlanData | undefined;

export function manifestSchema(): JsonSchema {
  cachedManifestSchema ??= readSchemaArtifact("resource-manifest-v0.schema.json") as JsonSchema;
  return cachedManifestSchema;
}

export function planData(): PlanData {
  cachedPlanData ??= readSchemaArtifact("plans-v0.json") as PlanData;
  return cachedPlanData;
}

/**
 * The `required_plan_key` the API reports when no self-serve plan allows a value (the private
 * UPGRADE_HINT_PLAN_ORDER falls through to its operator-assigned `internal` plan). It is never a
 * valid --plan value and is never offered as an upgrade.
 */
export const SUPPORT_ONLY_PLAN_KEY = "internal";

/** Public docs page for plan features and limits (the API's ENTITLEMENT_DOCS_URL). */
export const LIMITS_DOCS_URL = "https://docs.userland.fun/reference/limits/";

/** The self-serve plans, lowest first: Free plus the plans on sale. */
export function publicPlanKeys(): PlanKey[] {
  return [...planData().plan_order];
}

/** True for plans a customer can pick without operator help (the plans in plan_order). */
export function isSelfServePlan(planKey: PlanKey): boolean {
  return planData().plan_order.includes(planKey);
}

/**
 * Human text for "what plan unlocks this", matching the API's planRequirementText: never tells a
 * customer to buy a plan that is not on sale.
 */
export function planRequirementText(planKey: PlanKey): string {
  return isSelfServePlan(planKey) ? `requires ${planDisplayName(planKey)}` : "is not available on self-serve plans; contact support";
}

/** Returns the canonical public plan key, or undefined when the value is not a public plan. */
export function normalizePlanKey(value: string): PlanKey | undefined {
  const data = planData();
  const lowered = value.trim().toLowerCase();
  const key = data.plan_aliases[lowered] ?? lowered;
  return data.plan_order.includes(key) ? key : undefined;
}

/** Display name for a plan key. Keys outside the public table (an account on a retired or operator-assigned plan) are title-cased. */
export function planDisplayName(planKey: PlanKey): string {
  return planData().plans[planKey]?.display_name ?? planKey.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function readSchemaArtifact(name: string): unknown {
  // Built package: dist/schemas/<name> (copied by `npm run cli:build`).
  // Source checkout (tsx cli/src/*.ts): <repo>/schemas/<name>.
  const candidates = [new URL(`./schemas/${name}`, import.meta.url), new URL(`../../schemas/${name}`, import.meta.url)];
  for (const candidate of candidates) {
    let contents: string;
    try {
      contents = readFileSync(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    return JSON.parse(contents) as unknown;
  }
  throw new Error(`Unable to find the bundled ${name} artifact.`);
}

// ---------------------------------------------------------------------------
// Directory validation
// ---------------------------------------------------------------------------

export async function validateAppDirectory(rootDir: string, options: ValidateOptions = {}): Promise<ValidationReport> {
  return applyPlan(await analyzeAppDirectory(rootDir, { strict: options.strict }), options);
}

/**
 * Reads the manifest and release files once and runs every plan-independent check.
 * The `apps publish` preflight calls this, then applyPlan with the account's entitlements.
 */
export async function analyzeAppDirectory(rootDir: string, options: { strict?: boolean } = {}): Promise<AppAnalysis> {
  const report: ValidationReport = {
    ok: false,
    plan: null,
    plan_source: null,
    required_plan_key: null,
    violations: [],
    plan_gated: [],
    errors: [],
    warnings: [],
    manifest_file: null,
    release: { file_count: 0, bundle_bytes: 0 },
    embed_origins: null
  };
  const absoluteRoot = path.resolve(rootDir);
  const stat = await fs.stat(absoluteRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    report.errors.push({ code: "directory_not_found", manifest_path: "", message: `Directory not found: ${rootDir}` });
    return { report, requirements: null };
  }

  const loaded = await loadManifestFile(absoluteRoot, report);
  if (loaded === undefined) {
    return { report: finish(report), requirements: null };
  }
  const { document } = loaded;

  const cliKeys = Object.fromEntries(Object.entries(document).filter(([key]) => CLI_MANIFEST_KEYS.has(key)));
  const manifestDocument = Object.fromEntries(Object.entries(document).filter(([key]) => !CLI_MANIFEST_KEYS.has(key)));
  if (manifestDocument.app === undefined) {
    manifestDocument.app = { name: path.basename(absoluteRoot) };
    if (loaded.file !== null) {
      report.warnings.push({ code: "default_app", manifest_path: "app", message: `app is missing; the CLI publishes with app.name=${path.basename(absoluteRoot)}.` });
    }
  }
  if (manifestDocument.runtime === undefined) {
    manifestDocument.runtime = { static_root: "public", fallback: "index.html" };
    if (loaded.file !== null) {
      report.warnings.push({ code: "default_runtime", manifest_path: "runtime", message: 'runtime is missing; the CLI publishes with runtime.static_root="public" and runtime.fallback="index.html".' });
    }
  }

  const check = checkManifestDocument(manifestDocument);
  const cliCheck = validateCliKeys(cliKeys);
  const manifestErrors = [...check.errors, ...cliCheck.errors];
  const schemaStrict = [...check.schema_strict, ...cliCheck.schema_strict];
  report.errors.push(...manifestErrors);
  if (options.strict) {
    report.errors.push(...schemaStrict);
  } else {
    report.warnings.push(...schemaStrict);
  }

  const releaseFiles = await collectReleaseFiles(absoluteRoot, document, loaded.file, report);
  await checkRuntimePaths(absoluteRoot, check.normalized, releaseFiles, report);

  let requirements: Requirement[] | null = null;
  if (manifestErrors.length === 0) {
    const normalized = check.normalized;
    const input: ManifestInput = {
      app: normalized.app as Record<string, unknown>,
      runtime: normalized.runtime as Record<string, unknown>,
      resources: (normalized.resources as Record<string, unknown> | undefined) ?? {}
    };
    requirements = [
      ...analyzeManifestRequirements(input),
      ...releaseRequirements(report.release.file_count, report.release.bundle_bytes)
    ];
    report.required_plan_key = minimumPlanFor(requirements);
    report.plan_gated = evaluateRequirements(requirements, "free", planData().plans.free);
    report.embed_origins = embedOriginList(input.runtime.embed_origins);
  }

  return { report: finish(report), requirements };
}

/** Checks an analysis against a plan (the public plan table, or an account's entitlements). */
export function applyPlan(analysis: AppAnalysis, options: ValidateOptions = {}): ValidationReport {
  const report: ValidationReport = { ...analysis.report, violations: [] };
  report.plan = options.planKey ?? null;
  report.plan_source = options.planKey ? options.planSource ?? "flag" : null;
  if (options.planKey && analysis.requirements) {
    const config = options.entitlements ?? planData().plans[options.planKey];
    if (!config) {
      throw new Error(`Unknown plan: ${options.planKey}`);
    }
    report.violations = evaluateRequirements(analysis.requirements, options.planKey, config);
  }
  return finish(report);
}

function finish(report: ValidationReport): ValidationReport {
  report.ok = report.errors.length === 0 && report.violations.length === 0;
  return report;
}

async function loadManifestFile(rootDir: string, report: ValidationReport): Promise<{ document: Record<string, unknown>; file: string | null } | undefined> {
  const found = await findManifest(rootDir);
  report.manifest_file = found.file;
  if (found.file === LEGACY_MANIFEST_FILE) {
    report.warnings.push({ code: "legacy_manifest", manifest_path: "", message: `Using legacy ${LEGACY_MANIFEST_FILE}; rename it to ${MANIFEST_FILE}.` });
  }
  if (!found.ok) {
    report.errors.push({ code: found.code, manifest_path: "", message: found.message });
    return undefined;
  }
  if (found.file === null) {
    if (found.webAppManifest) {
      report.warnings.push({
        code: "web_app_manifest",
        manifest_path: "",
        file: LEGACY_MANIFEST_FILE,
        message: `has no app, runtime, resources, or files keys, so it is treated as an ordinary file (such as a web app manifest) and uploaded, not read as the Userland manifest.`
      });
    }
    report.warnings.push({
      code: "missing_manifest",
      manifest_path: "",
      message: `No ${MANIFEST_FILE} found; the CLI publishes every file with default app and runtime settings.`
    });
  }
  return { document: found.document, file: found.file };
}

export type ManifestLookup =
  | {
      ok: true;
      document: Record<string, unknown>;
      /** The manifest file name at the top of the app folder, or null when there is none. */
      file: string | null;
      /** A top-level manifest.json was found but is not a Userland manifest, so it is an ordinary release file. */
      webAppManifest: boolean;
    }
  | { ok: false; file: string; code: "invalid_json" | "invalid_manifest"; message: string };

/**
 * Finds the Userland manifest: manifest.userland.json, or else a top-level manifest.json (the older
 * name) that holds Userland keys. A manifest.json without app, runtime, resources, or files (such as a
 * web app manifest) is not the Userland manifest; `apps publish` uploads it like any other file.
 */
export async function findManifest(rootDir: string): Promise<ManifestLookup> {
  let webAppManifest = false;
  for (const name of [MANIFEST_FILE, LEGACY_MANIFEST_FILE]) {
    const contents = await fs.readFile(path.join(rootDir, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return undefined;
      throw error;
    });
    if (contents === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      return { ok: false, file: name, code: "invalid_json", message: `${name} is not valid JSON: ${(error as Error).message}` };
    }
    if (name === LEGACY_MANIFEST_FILE && !(isPlainObject(parsed) && USERLAND_MANIFEST_KEYS.some((key) => key in parsed))) {
      webAppManifest = true;
      continue;
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, file: name, code: "invalid_manifest", message: `${name} must contain a JSON object.` };
    }
    return { ok: true, document: parsed, file: name, webAppManifest: false };
  }
  return { ok: true, document: {}, file: null, webAppManifest };
}

/** Schema validation plus the cross-field rules the API enforces for app, runtime, and resources. */
export function validateManifestDocument(document: Record<string, unknown>): ValidationIssue[] {
  return checkManifestDocument(document).errors;
}

export interface ManifestCheck {
  /** Problems the API rejects when publishing (400 invalid_*_manifest). */
  errors: ValidationIssue[];
  /** Places the published schema is stricter than the API; the API accepts these today. */
  schema_strict: ValidationIssue[];
  /** The document after the API's own normalization (what plan analysis runs on). */
  normalized: Record<string, unknown>;
}

/**
 * Validates a manifest document ({ app, runtime, resources }) against the published schema,
 * then separates what the API would reject from schema-only strictness it tolerates:
 * unknown keys under the top level, app, runtime, or resources; `resources: null`; null
 * defaults; whitespace the API trims; and a few schema-only name rules. Publishing must
 * not block on the second group, so it is reported with code `schema_strict`.
 */
export function checkManifestDocument(document: Record<string, unknown>): ManifestCheck {
  const schema = manifestSchema();
  const strictErrors = schemaErrors(document, schema);
  if (strictErrors.length === 0) {
    return { errors: semanticManifestErrors(document), schema_strict: [], normalized: document };
  }
  const normalized = normalizeLikeApi(document);
  const apiErrors = schemaErrors(normalized, schema).filter((error) => !apiToleratesSchemaError(error, normalized));
  const errors = withEveryEmbedOriginError(preferApiMessages(apiErrors.map(toIssue), normalized), normalized);
  const blockingPaths = new Set(errors.map((error) => error.manifest_path));
  const schemaStrict = strictErrors
    .map(toIssue)
    .filter((error) => !blockingPaths.has(error.manifest_path))
    .map((error) => ({
      code: "schema_strict",
      manifest_path: error.manifest_path,
      message: `${error.message} in the published manifest schema; the API accepts it today, but fix it to keep the manifest schema-valid.`
    }));
  return {
    errors: errors.length > 0 ? errors : semanticManifestErrors(normalized),
    schema_strict: schemaStrict,
    normalized
  };
}

/**
 * The schema and the API's cross-field rules can flag the same field (for example a signed
 * webhook without a secret). The cross-field message says why ("is required when provider is
 * github"), so it replaces the schema's generic one for that path. Cross-field rules assume a
 * well-formed document, so any failure there keeps the schema messages as they are. Several schema
 * rules can fail on one value (a runtime.embed_origins entry that is too long and not an origin), so
 * a replacement is reported once.
 */
function preferApiMessages(errors: ValidationIssue[], document: Record<string, unknown>): ValidationIssue[] {
  let semantic: ValidationIssue[];
  try {
    semantic = semanticManifestErrors(document);
  } catch {
    return errors;
  }
  const byPath = new Map(semantic.map((issue) => [issue.manifest_path, issue]));
  const replaced = errors.map((issue) => byPath.get(issue.manifest_path) ?? issue);
  return replaced.filter((issue, index) => replaced.indexOf(issue) === index);
}

/**
 * Other cross-field rules wait until the schema errors are fixed, but runtime.embed_origins entries
 * are checked one at a time, so when there are schema errors every bad entry is still reported, in
 * list order, after the other errors.
 */
function withEveryEmbedOriginError(errors: ValidationIssue[], document: Record<string, unknown>): ValidationIssue[] {
  if (errors.length === 0) return errors;
  const embedErrors = embedOriginErrors(isPlainObject(document.runtime) ? document.runtime.embed_origins : undefined);
  const embedPaths = new Set(embedErrors.map((issue) => issue.manifest_path));
  return [...errors.filter((issue) => !embedPaths.has(issue.manifest_path)), ...embedErrors];
}

/** Applies the API's lenient parsing so only the rules it enforces remain for the schema. */
function normalizeLikeApi(document: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(document);
  const dropUnknown = (value: unknown, allowed: Set<string>): void => {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) delete value[key];
    }
  };
  dropUnknown(copy, schemaPropertyKeys([]));
  dropUnknown(copy.app, schemaPropertyKeys(["app"]));
  dropUnknown(copy.runtime, schemaPropertyKeys(["runtime"]));
  if (copy.resources === null) {
    delete copy.resources;
  }
  dropUnknown(copy.resources, schemaPropertyKeys(["resources"]));

  const trimStrings = (values: unknown, transform: (value: string) => string = (value) => value.trim()): unknown =>
    Array.isArray(values) ? values.map((value) => (typeof value === "string" ? transform(value) : value)) : values;
  if (isPlainObject(copy.app) && copy.app.tags !== undefined) {
    copy.app.tags = trimStrings(copy.app.tags);
  }
  const resources = isPlainObject(copy.resources) ? copy.resources : {};
  if (isPlainObject(resources.auth) && resources.auth.mode === null) {
    delete resources.auth.mode;
  }
  if (isPlainObject(resources.secrets) && resources.secrets.required !== undefined) {
    resources.secrets.required = trimStrings(resources.secrets.required);
  }
  for (const [, store] of objectEntries(isPlainObject(resources.files) ? resources.files.stores : undefined)) {
    if (isPlainObject(store) && store.allowed_content_types !== undefined) {
      store.allowed_content_types = trimStrings(store.allowed_content_types, (value) => value.trim().toLowerCase());
    }
  }
  for (const [, job] of objectEntries(resources.jobs)) {
    if (!isPlainObject(job)) continue;
    if (job.trigger === null) delete job.trigger;
    if (job.max_attempts === null) delete job.max_attempts;
  }
  for (const [, webhook] of objectEntries(resources.webhooks)) {
    if (isPlainObject(webhook) && typeof webhook.secret === "string") {
      webhook.secret = webhook.secret.trim();
    }
  }
  return copy;
}

/**
 * Schema rules with no API counterpart: reserved data index names, empty enum values, repeated
 * runtime.embed_origins entries (the API drops repeats), and embed origins the API accepts in a form
 * the schema does not (such as `HTTPS://` in capital letters, which the API stores in lowercase).
 */
function apiToleratesSchemaError(error: SchemaError, document: Record<string, unknown>): boolean {
  const at = error.path;
  const last = at[at.length - 1];
  const parent = at[at.length - 2];
  if (at[0] === "runtime" && at[1] === "embed_origins") {
    if (at.length === 2) return error.keyword === "uniqueItems";
    const origins = isPlainObject(document.runtime) ? document.runtime.embed_origins : undefined;
    return at.length === 3 && typeof last === "number" && Array.isArray(origins) && checkEmbedOrigin(origins[last]).ok;
  }
  if (at[0] !== "resources" || at[1] !== "data") return false;
  if (last === "name" && typeof parent === "number" && at[at.length - 3] === "indexes") {
    return error.keyword === "not";
  }
  if (typeof last === "number" && parent === "values") {
    return error.keyword === "minLength";
  }
  return false;
}

function schemaPropertyKeys(at: string[]): Set<string> {
  const root = manifestSchema();
  const deref = (node: unknown): unknown => (isPlainObject(node) && typeof node.$ref === "string" ? deref(resolveRef(root, node.$ref)) : node);
  let node = deref(root);
  for (const part of at) {
    node = isPlainObject(node) && isPlainObject(node.properties) ? deref(node.properties[part]) : undefined;
  }
  return new Set(isPlainObject(node) && isPlainObject(node.properties) ? Object.keys(node.properties) : []);
}

/**
 * Checks the top-level keys the CLI reads itself. A wrong type for `$schema`, `message`, or
 * `provenance` (and an unknown key in a `files` entry) is ignored when publishing: the CLI never
 * sends `$schema`, sends only a string `message` (the API also ignores any other type), and sends
 * `{}` for a non-object `provenance`. Those are `schema_strict` issues, like other rules the API
 * tolerates. Malformed `files` change which files are uploaded, so they stay errors.
 */
function validateCliKeys(cliKeys: Record<string, unknown>): { errors: ValidationIssue[]; schema_strict: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const schemaStrict: ValidationIssue[] = [];
  if (cliKeys.$schema !== undefined && typeof cliKeys.$schema !== "string") {
    schemaStrict.push({ code: "schema_strict", manifest_path: "$schema", message: "must be a string (ignored when publishing)" });
  }
  if (cliKeys.message !== undefined && typeof cliKeys.message !== "string") {
    schemaStrict.push({ code: "schema_strict", manifest_path: "message", message: "must be a string (ignored when publishing)" });
  }
  if (cliKeys.provenance !== undefined && !isPlainObject(cliKeys.provenance)) {
    schemaStrict.push({ code: "schema_strict", manifest_path: "provenance", message: "must be an object (ignored when publishing)" });
  }
  if (cliKeys.files !== undefined) {
    if (!Array.isArray(cliKeys.files)) {
      errors.push({ code: "schema", manifest_path: "files", message: "must be an array of { path, content_type } objects" });
    } else {
      cliKeys.files.forEach((entry, index) => {
        const entryPath = `files[${index}]`;
        if (!isPlainObject(entry)) {
          errors.push({ code: "schema", manifest_path: entryPath, message: "must be an object with path" });
          return;
        }
        for (const key of Object.keys(entry)) {
          if (key !== "path" && key !== "content_type") {
            schemaStrict.push({ code: "schema_strict", manifest_path: `${entryPath}.${key}`, message: "is not an allowed key (ignored when publishing)" });
          }
        }
        if (typeof entry.path !== "string" || entry.path.length === 0) {
          errors.push({ code: "schema", manifest_path: `${entryPath}.path`, message: "is required and must be a non-empty string" });
        }
        if (entry.content_type !== undefined && (typeof entry.content_type !== "string" || !isValidContentType(entry.content_type))) {
          errors.push({ code: "schema", manifest_path: `${entryPath}.content_type`, message: "must be a valid MIME type such as text/html" });
        }
      });
    }
  }
  return { errors, schema_strict: schemaStrict };
}

/** Cross-field rules the API enforces that JSON Schema cannot express. */
function semanticManifestErrors(document: Record<string, unknown>): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const app = document.app as Record<string, unknown>;
  if (typeof app.name === "string" && app.name.trim().length === 0) {
    errors.push({ code: "invalid_manifest", manifest_path: "app.name", message: "must not be blank" });
  }
  const runtime = document.runtime as Record<string, unknown>;
  for (const key of ["static_root", "server_entry"]) {
    const value = runtime[key];
    const pathError = typeof value === "string" ? releasePathError(value) : undefined;
    if (pathError) {
      errors.push({ code: "unsafe_path", manifest_path: `runtime.${key}`, message: `${value}: ${pathError}` });
    }
  }
  errors.push(...embedOriginErrors(runtime.embed_origins));

  const resources = (document.resources as Record<string, unknown> | undefined) ?? {};
  const collections = objectEntries((resources.data as Record<string, unknown> | undefined)?.collections);
  for (const [collectionName, collectionValue] of collections) {
    const collection = collectionValue as Record<string, unknown>;
    const fields = (collection.fields as Record<string, unknown> | undefined) ?? {};
    const seenIndexNames = new Set<string>();
    ((collection.indexes as Array<Record<string, unknown>> | undefined) ?? []).forEach((index, indexPosition) => {
      const indexPath = `resources.data.collections.${collectionName}.indexes[${indexPosition}]`;
      const name = index.name as string;
      if (seenIndexNames.has(name)) {
        errors.push({ code: "invalid_resource_manifest", manifest_path: `${indexPath}.name`, message: `duplicate index name ${name}` });
      }
      seenIndexNames.add(name);
      (index.fields as string[]).forEach((field, fieldPosition) => {
        if (!(field in fields)) {
          errors.push({ code: "invalid_resource_manifest", manifest_path: `${indexPath}.fields[${fieldPosition}]`, message: `index field ${field} is not declared in fields` });
        }
      });
    });
    const access = (collection.access as Record<string, unknown> | undefined) ?? {};
    for (const mode of ["read", "write"]) {
      const rule = access[mode];
      if (typeof rule === "string" && rule.startsWith("role:") && RESERVED_RESOURCE_NAMES.has(rule.slice("role:".length))) {
        errors.push({ code: "invalid_resource_manifest", manifest_path: `resources.data.collections.${collectionName}.access.${mode}`, message: `role ${rule.slice("role:".length)} is reserved` });
      }
    }
  }

  for (const [storeName, storeValue] of objectEntries((resources.files as Record<string, unknown> | undefined)?.stores)) {
    const contentTypes = ((storeValue as Record<string, unknown>).allowed_content_types as string[] | undefined) ?? [];
    const normalized = contentTypes.map((value) => value.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      errors.push({ code: "invalid_resource_manifest", manifest_path: `resources.files.stores.${storeName}.allowed_content_types`, message: "must not contain duplicates (content types are case-insensitive)" });
    }
  }

  const jobs = (resources.jobs as Record<string, unknown> | undefined) ?? {};
  for (const [webhookName, webhookValue] of objectEntries(resources.webhooks)) {
    const webhook = webhookValue as Record<string, unknown>;
    if (webhook.provider !== "none" && typeof webhook.secret !== "string") {
      errors.push({ code: "invalid_resource_manifest", manifest_path: `resources.webhooks.${webhookName}.secret`, message: `is required when provider is ${String(webhook.provider)}` });
    }
    const target = webhook.deliver_to === "job" ? webhook.job : typeof webhook.deliver_to === "string" && webhook.deliver_to.startsWith("job:") ? webhook.deliver_to.slice("job:".length) : undefined;
    if (typeof target === "string" && !(target in jobs)) {
      const targetPath = webhook.deliver_to === "job" ? "job" : "deliver_to";
      errors.push({ code: "invalid_resource_manifest", manifest_path: `resources.webhooks.${webhookName}.${targetPath}`, message: `webhook job target ${target} is not declared in resources.jobs` });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// runtime.embed_origins (mirrors checkEmbedOrigin and validateEmbedOrigins in the API)
// ---------------------------------------------------------------------------

// The other sites allowed to show the app in a frame on its *.apps.userland.fun addresses. Apps
// there share one site in browsers (apps.userland.fun is not on the Public Suffix List), so by
// default only the app's own pages may frame it. The API writes each entry into the app's
// `Content-Security-Policy: frame-ancestors` header, so an entry must be exactly one https origin.

/** runtime.embed_origins can list at most this many sites. */
export const EMBED_ORIGINS_MAX_COUNT = 20;
export const EMBED_ORIGIN_MAX_LENGTH = 255;
/** Every host under this domain is Userland's (apps, the product site, docs, the console, the API). */
const USERLAND_DOMAIN = "userland.fun";
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Two labels at least: a single label (`localhost`) is not a site, and a wildcard over one (`*.com`)
// would allow every site under a top-level domain.
const EMBED_ORIGIN_PATTERN = new RegExp(`^https://(\\*\\.)?((?:${DNS_LABEL}\\.)+${DNS_LABEL})(?::([1-9][0-9]{0,4}))?$`, "u");
const EMBED_ORIGIN_EXAMPLE = "for example https://example.com or https://*.example.com";

export type EmbedOriginCheck = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Checks one runtime.embed_origins entry the way the API does, with the API's wording. The origin
 * is returned in lowercase, as the API stores it. The API also refuses its own deployment's domains;
 * for Userland that is every host under userland.fun, which is refused here too.
 */
export function checkEmbedOrigin(value: unknown): EmbedOriginCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: `must be a text value such as "https://example.com"` };
  }
  if (value.length > EMBED_ORIGIN_MAX_LENGTH) {
    return { ok: false, reason: `must be at most ${EMBED_ORIGIN_MAX_LENGTH} characters` };
  }
  const shown = JSON.stringify(value);
  if (value.trim().toLowerCase() === "'self'") {
    return { ok: false, reason: `(${shown}) is not needed: the app's own pages can always show it in a frame` };
  }
  if (/[\s'";,]/u.test(value)) {
    return { ok: false, reason: `(${shown}) must be one origin, without spaces, quotes, commas or semicolons, ${EMBED_ORIGIN_EXAMPLE}` };
  }
  const origin = value.toLowerCase();
  if (origin === "*" || origin === "https://*" || origin === "https:") {
    return { ok: false, reason: `(${shown}) must name a site: allowing every site is not supported` };
  }
  if (!origin.startsWith("https://")) {
    return { ok: false, reason: origin.startsWith("http://") ? `(${shown}) must use https://` : `(${shown}) must start with https://, ${EMBED_ORIGIN_EXAMPLE}` };
  }
  if (/[/?#]/u.test(origin.slice("https://".length))) {
    return { ok: false, reason: `(${shown}) must be an origin without a path, query or fragment (no trailing slash), ${EMBED_ORIGIN_EXAMPLE}` };
  }
  const match = EMBED_ORIGIN_PATTERN.exec(origin);
  if (match === null) {
    return { ok: false, reason: `(${shown}) must be https:// and a domain name with an optional port, and may start with *. to cover its subdomains, ${EMBED_ORIGIN_EXAMPLE}` };
  }
  const [, , host, port] = match;
  if (/^[0-9]+$/u.test(host.slice(host.lastIndexOf(".") + 1))) {
    return { ok: false, reason: `(${shown}) must use a domain name, not an IP address` };
  }
  if (port !== undefined && Number(port) > 65535) {
    return { ok: false, reason: `(${shown}) has a port above 65535` };
  }
  // A wildcard over userland.fun's own base (`*.fun`) is already refused by the pattern.
  if (host === USERLAND_DOMAIN || host.endsWith(`.${USERLAND_DOMAIN}`)) {
    return { ok: false, reason: `(${shown}) cannot be a Userland address: other apps and Userland sites can never show this app in a frame` };
  }
  return { ok: true, origin };
}

/**
 * The API's `400 invalid_runtime_manifest` errors for runtime.embed_origins, one per problem (the API
 * stops at the first). Messages are the API's own, so local and published errors read the same.
 */
function embedOriginErrors(value: unknown): ValidationIssue[] {
  if (value === undefined) return [];
  const issue = (manifestPath: string, message: string): ValidationIssue => ({ code: "invalid_runtime_manifest", manifest_path: manifestPath, message });
  if (!Array.isArray(value)) {
    return [issue("runtime.embed_origins", 'runtime.embed_origins must be a list of https origins, for example ["https://example.com"].')];
  }
  const errors: ValidationIssue[] = [];
  if (value.length > EMBED_ORIGINS_MAX_COUNT) {
    errors.push(issue("runtime.embed_origins", `runtime.embed_origins can list at most ${EMBED_ORIGINS_MAX_COUNT} sites.`));
  }
  value.forEach((entry, index) => {
    const check = checkEmbedOrigin(entry);
    if (!check.ok) {
      errors.push(issue(`runtime.embed_origins[${index}]`, `runtime.embed_origins[${index}] ${check.reason}.`));
    }
  });
  return errors;
}

/** The sites a valid runtime.embed_origins allows, as the API stores them: lowercase, without repeats. */
export function embedOriginList(value: unknown): string[] {
  const origins: string[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const check = checkEmbedOrigin(entry);
    if (check.ok && !origins.includes(check.origin)) {
      origins.push(check.origin);
    }
  }
  return origins;
}

// ---------------------------------------------------------------------------
// Release files and runtime paths
// ---------------------------------------------------------------------------

export interface ReleaseFileListing {
  files: ReleaseFileEntry[];
  /** True when the list comes from the manifest's `files`; otherwise the folder was walked. */
  fromManifest: boolean;
  /** Symlinks the folder walk did not follow or upload. */
  skippedSymlinks: string[];
  /** Dotfiles and dot-folders (folders end in "/") the folder walk left out, such as .env, .npmrc, and .git/. */
  skippedDotfiles: string[];
  /** Private keys the folder walk found; publishing refuses to upload them. */
  privateKeys: string[];
}

/**
 * Lists the files `apps publish` would upload. With manifest `files`, exactly those paths (check each
 * with releaseFileProblem before reading it). Otherwise every regular file under the folder except the
 * Userland manifest itself, symlinks, private keys, and dotfiles and dot-folders (other than .well-known/
 * and dot-folders that runtime.static_root or runtime.server_entry name). `manifestFile` is the manifest
 * findManifest loaded; only that top-level file is left out, so a web app manifest.json is uploaded.
 */
export async function listReleaseFiles(rootDir: string, document: Record<string, unknown>, options: { manifestFile: string | null }): Promise<ReleaseFileListing> {
  const listing: ReleaseFileListing = { files: [], fromManifest: false, skippedSymlinks: [], skippedDotfiles: [], privateKeys: [] };
  const manifestFiles = Array.isArray(document.files) ? document.files : null;
  if (manifestFiles && manifestFiles.length > 0) {
    listing.fromManifest = true;
    listing.files = manifestFiles
      .filter((entry): entry is { path: string; content_type?: unknown } => isPlainObject(entry) && typeof entry.path === "string")
      .map((entry) => ({
        path: entry.path,
        absolutePath: path.join(rootDir, entry.path),
        ...(typeof entry.content_type === "string" ? { contentType: entry.content_type } : {})
      }));
    return listing;
  }
  const walked = await walk(rootDir, { keepDotFolders: manifestDotFolders(document) });
  listing.skippedSymlinks = walked.symlinks.map((filePath) => toReleasePath(rootDir, filePath)).sort();
  listing.skippedDotfiles = walked.dotfiles
    .map((filePath) => `${toReleasePath(rootDir, filePath)}${filePath.endsWith(path.sep) ? "/" : ""}`)
    .sort();
  for (const filePath of walked.files.sort()) {
    const releasePath = toReleasePath(rootDir, filePath);
    if (options.manifestFile !== null && releasePath === options.manifestFile) {
      continue;
    }
    if (await isPrivateKeyFile(filePath)) {
      listing.privateKeys.push(releasePath);
      continue;
    }
    listing.files.push({ path: releasePath, absolutePath: filePath });
  }
  return listing;
}

function toReleasePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

/**
 * Checks a release path before its file is read: the API's path rules, then that it is a regular file
 * inside the app folder and that neither it nor any folder above it (below the app folder) is a symlink.
 * Returns the file's stats when it is safe to read.
 */
export async function releaseFileProblem(
  rootDir: string,
  releasePath: string
): Promise<{ ok: true; size: number } | { ok: false; code: "unsafe_path" | "symlink" | "missing_file"; message: string }> {
  const pathError = releasePathError(releasePath);
  if (pathError) {
    return { ok: false, code: "unsafe_path", message: pathError };
  }
  const parts = releasePath.split("/");
  let current = path.resolve(rootDir);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const entryStat = await fs.lstat(current).catch(() => null);
    const last = index === parts.length - 1;
    if (entryStat?.isSymbolicLink()) {
      const where = last ? "is a symlink" : `is inside ${parts.slice(0, index + 1).join("/")}/, which is a symlink`;
      return { ok: false, code: "symlink", message: `${where}. Userland only uploads regular files that are inside the app folder; copy the file into place instead.` };
    }
    if (!entryStat || (last && !entryStat.isFile())) {
      return { ok: false, code: "missing_file", message: "does not exist or is not a file" };
    }
    if (last) {
      return { ok: true, size: entryStat.size };
    }
  }
  return { ok: false, code: "missing_file", message: "does not exist or is not a file" };
}

/** Private SSH keys by name, key stores, and .pem or .key files that hold a private key. */
async function isPrivateKeyFile(filePath: string): Promise<boolean> {
  const basename = path.basename(filePath);
  const extension = path.extname(basename).toLowerCase();
  if (PRIVATE_KEY_NAME.test(basename) && extension !== ".pub") return true;
  if (KEY_STORE_EXTENSIONS.has(extension)) return true;
  if (!PEM_EXTENSIONS.has(extension)) return false;
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("latin1").includes("PRIVATE KEY-----");
  } finally {
    await handle.close();
  }
}

function summarizePaths(paths: string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown}, and ${paths.length - 5} more` : shown;
}

/** Plain-language warnings for what a folder publish leaves out (shared by validate and publish). */
export function releaseListingWarnings(listing: ReleaseFileListing): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  if (listing.skippedDotfiles.length > 0) {
    const count = listing.skippedDotfiles.length;
    warnings.push({
      code: "dotfiles_skipped",
      manifest_path: "",
      message: `${count} dotfile${count === 1 ? " or dot-folder is" : "s and dot-folders are"} not uploaded (${summarizePaths(listing.skippedDotfiles)}). Files such as .env, .npmrc, and .git/ can hold passwords and keys, so publishing a folder leaves out every name that starts with a dot (except .well-known/). To upload one on purpose, list every release file in manifest.userland.json files.`
    });
  }
  if (listing.skippedSymlinks.length > 0) {
    const count = listing.skippedSymlinks.length;
    warnings.push({
      code: "symlinks_skipped",
      manifest_path: "",
      message: `${count} symlink${count === 1 ? " is" : "s are"} not uploaded (${summarizePaths(listing.skippedSymlinks)}); copy the files into the app directory instead.`
    });
  }
  return warnings;
}

/** The error publishing reports when a folder walk finds private keys. */
export function privateKeyMessage(): string {
  return "looks like a private key, so it is not uploaded. Move it out of the app folder, or publish a build folder that does not contain it. If the file is meant to be public, list every release file in manifest.userland.json files.";
}

async function collectReleaseFiles(rootDir: string, document: Record<string, unknown>, manifestFile: string | null, report: ValidationReport): Promise<Set<string>> {
  const bundle = planData().bundle_limits;
  const listing = await listReleaseFiles(rootDir, document, { manifestFile });
  const entries = listing.files;
  const fromManifest = listing.fromManifest;
  const seen = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;

  for (const privateKey of listing.privateKeys) {
    report.errors.push({ code: "private_key", manifest_path: "", file: privateKey, message: privateKeyMessage() });
  }
  for (const [index, entry] of entries.entries()) {
    const entryPath = fromManifest ? `files[${index}].path` : "";
    const pathError = releasePathError(entry.path);
    if (pathError) {
      report.errors.push({ code: "unsafe_path", manifest_path: entryPath, file: entry.path, message: pathError });
      continue;
    }
    if (seen.has(entry.path)) {
      report.errors.push({ code: "duplicate_path", manifest_path: entryPath, file: entry.path, message: "is listed more than once" });
      continue;
    }
    seen.add(entry.path);
    const fileStat = await releaseFileProblem(rootDir, entry.path);
    if (!fileStat.ok) {
      report.errors.push({ code: fileStat.code, manifest_path: entryPath, file: entry.path, message: fileStat.message });
      continue;
    }
    fileCount += 1;
    totalBytes += fileStat.size;
    if (fileStat.size > bundle["file_bytes.max"]) {
      report.errors.push({ code: "file_too_large", manifest_path: entryPath, file: entry.path, message: `is ${fileStat.size} bytes; each file must be at most ${bundle["file_bytes.max"]} bytes` });
    }
  }

  if (entries.length === 0) {
    report.errors.push({ code: "empty_release", manifest_path: fromManifest ? "files" : "", message: "Publish directory must contain at least one file." });
  }
  if (fileCount > bundle["files.max"]) {
    report.errors.push({ code: "bundle_too_large", manifest_path: "release.file_count", message: `Release has ${fileCount} files; the maximum is ${bundle["files.max"]}` });
  }
  if (totalBytes > bundle["bundle_bytes.max"]) {
    report.errors.push({ code: "bundle_too_large", manifest_path: "release.bundle_bytes", message: `Release is ${totalBytes} bytes; the maximum is ${bundle["bundle_bytes.max"]}` });
  }
  report.warnings.push(...releaseListingWarnings(listing));
  if (!fromManifest && Array.from(seen).some((filePath) => filePath === "node_modules" || filePath.startsWith("node_modules/"))) {
    report.warnings.push({ code: "unexpected_release_files", manifest_path: "", message: "node_modules/ would be uploaded; publish a build directory or list files in manifest.userland.json files." });
  }

  report.release = { file_count: fileCount, bundle_bytes: totalBytes };
  return seen;
}

async function checkRuntimePaths(rootDir: string, document: Record<string, unknown>, releasePaths: Set<string>, report: ValidationReport): Promise<void> {
  const runtime = isPlainObject(document.runtime) ? document.runtime : {};
  const alreadyReported = (manifestPath: string) => report.errors.some((error) => error.manifest_path === manifestPath);
  const staticRoot = runtime.static_root;
  if (typeof staticRoot === "string" && !alreadyReported("runtime.static_root")) {
    const pathError = releasePathError(staticRoot);
    if (pathError) {
      report.errors.push({ code: "unsafe_path", manifest_path: "runtime.static_root", message: `${staticRoot}: ${pathError}` });
    } else {
      const prefix = `${staticRoot.replace(/\/$/u, "")}/`;
      const staticStat = await fs.stat(path.join(rootDir, staticRoot)).catch(() => null);
      if (!staticStat) {
        report.errors.push({ code: "missing_file", manifest_path: "runtime.static_root", message: `${staticRoot} does not exist` });
      } else if (!Array.from(releasePaths).some((filePath) => filePath.startsWith(prefix))) {
        report.errors.push({ code: "missing_static_root", manifest_path: "runtime.static_root", message: `${staticRoot} must contain at least one release file` });
      } else if (runtime.fallback === "index.html" && !releasePaths.has(`${prefix}index.html`)) {
        report.warnings.push({ code: "missing_fallback", manifest_path: "runtime.fallback", message: `runtime.fallback is index.html but ${prefix}index.html is not in the release.` });
      }
    }
  }
  const serverEntry = runtime.server_entry;
  if (typeof serverEntry === "string" && !alreadyReported("runtime.server_entry")) {
    const pathError = releasePathError(serverEntry);
    if (pathError) {
      report.errors.push({ code: "unsafe_path", manifest_path: "runtime.server_entry", message: `${serverEntry}: ${pathError}` });
    } else if (!releasePaths.has(serverEntry)) {
      report.errors.push({ code: "missing_server_entry", manifest_path: "runtime.server_entry", message: `${serverEntry} must be a release file` });
    }
  }
}

/** Mirrors the API's release path rules; returns a reason when the path is unsafe. */
export function releasePathError(releasePath: string): string | undefined {
  if (releasePath.length === 0 || releasePath.length > 512) return "path must be 1-512 characters";
  if (releasePath.includes("\0")) return "path must not contain NUL";
  if (releasePath.startsWith("/")) return "absolute paths are not allowed; use a path relative to the app directory";
  if (releasePath.includes("\\")) return "backslashes are not allowed; use / separators";
  const parts = releasePath.split("/");
  if (parts.some((part) => part === "..")) return "parent directory segments (..) are not allowed";
  if (parts.some((part) => part === "" || part === ".")) return "empty or . segments are not allowed";
  if (releasePath === "_userland" || releasePath.startsWith("_userland/")) return "_userland/ is reserved by Userland";
  return undefined;
}

interface WalkResult {
  files: string[];
  symlinks: string[];
  dotfiles: string[];
}

/**
 * Lists regular files under rootDir. Symlinks are never followed or uploaded, and names that start
 * with a dot are left out without being read, except .well-known folders and the dot-folders on the
 * way to `keepDotFolders` (release paths such as `.output` for a runtime.static_root of
 * `.output/public`). Skipped entries are collected so callers can say what was left out; dot-folders
 * end with a path separator.
 */
export async function walk(rootDir: string, options: { keepDotFolders?: Set<string> } = {}): Promise<WalkResult> {
  const found: WalkResult = { files: [], symlinks: [], dotfiles: [] };
  const keep = options.keepDotFolders ?? new Set<string>();
  const visit = async (dir: string, releaseDir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        const releasePath = releaseDir ? `${releaseDir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          found.symlinks.push(entryPath);
          return;
        }
        const keptDotFolder = entry.isDirectory() && (ALLOWED_DOT_DIRECTORIES.has(entry.name) || keep.has(releasePath));
        if (entry.name.startsWith(".") && !keptDotFolder) {
          found.dotfiles.push(entry.isDirectory() ? `${entryPath}${path.sep}` : entryPath);
          return;
        }
        if (entry.isDirectory()) {
          await visit(entryPath, releasePath);
        } else if (entry.isFile()) {
          found.files.push(entryPath);
        }
      })
    );
  };
  await visit(rootDir, "");
  return found;
}

/** Dot-folders the manifest names on purpose in runtime.static_root or runtime.server_entry. */
function manifestDotFolders(document: Record<string, unknown>): Set<string> {
  const folders = new Set<string>();
  const runtime = isPlainObject(document.runtime) ? document.runtime : {};
  for (const [key, value] of Object.entries(runtime)) {
    if ((key !== "static_root" && key !== "server_entry") || typeof value !== "string" || releasePathError(value)) continue;
    const parts = value.replace(/\/$/u, "").split("/");
    const folderCount = key === "server_entry" ? parts.length - 1 : parts.length;
    for (let index = 0; index < folderCount; index += 1) {
      if (parts[index].startsWith(".")) folders.add(parts.slice(0, index + 1).join("/"));
    }
  }
  return folders;
}

function isValidContentType(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 255 && CONTENT_TYPE_PATTERN.test(normalized);
}

// ---------------------------------------------------------------------------
// Entitlement analysis (mirrors analyzeManifestEntitlements in the API)
// ---------------------------------------------------------------------------

/**
 * Lists every plan-relevant requirement a manifest declares. Paths point at the specific
 * resource where possible so agents can fix the exact entry.
 */
export function analyzeManifestRequirements(input: ManifestInput): Requirement[] {
  const requirements: Requirement[] = [];
  const feature = (key: string, manifestPath: string, value: unknown) => requirements.push({ kind: "feature", key, manifest_path: manifestPath, value });
  const limit = (key: string, manifestPath: string, value: number) => requirements.push({ kind: "limit", key, manifest_path: manifestPath, value });
  const { app, runtime, resources } = input;

  if (typeof runtime.static_root === "string" && runtime.static_root.length > 0) feature("runtime.static", "runtime.static_root", runtime.static_root);
  if (runtime.server_entry !== undefined) feature("runtime.server", "runtime.server_entry", runtime.server_entry);
  if (runtime.fallback === "server") feature("runtime.server", "runtime.fallback", runtime.fallback);
  if (app.visibility === "private") feature("private_apps", "app.visibility", app.visibility);

  const auth = isPlainObject(resources.auth) ? resources.auth : undefined;
  if (auth?.mode === "app_users") feature("auth.app_users", "resources.auth.mode", auth.mode);
  if (auth?.public_signup === true) feature("auth.public_signup", "resources.auth.public_signup", true);
  if (auth?.email_verification === true) feature("auth.email_verification", "resources.auth.email_verification", true);
  limit("auth.roles.max", "resources.auth.roles", Array.isArray(auth?.roles) ? auth.roles.length : 0);

  const collections = objectEntries(isPlainObject(resources.data) ? resources.data.collections : undefined);
  if (collections.length > 0) feature("data.enabled", "resources.data.collections", collections.length);
  limit("data.collections.max", "resources.data.collections", collections.length);
  for (const [name, collection] of collections) {
    const indexes = isPlainObject(collection) && Array.isArray(collection.indexes) ? collection.indexes.length : 0;
    limit("data.indexes_per_collection.max", `resources.data.collections.${name}.indexes`, indexes);
  }

  const stores = objectEntries(isPlainObject(resources.files) ? resources.files.stores : undefined);
  if (stores.length > 0) feature("files.enabled", "resources.files.stores", stores.length);
  for (const [name, store] of stores) {
    if (isPlainObject(store) && store.public === false) feature("files.private_stores", `resources.files.stores.${name}.public`, false);
  }
  limit("files.stores.max", "resources.files.stores", stores.length);
  for (const [name, store] of stores) {
    const size = isPlainObject(store) && typeof store.max_file_size_bytes === "number" ? store.max_file_size_bytes : 0;
    if (size > 0) limit("files.max_upload_size_bytes.max", `resources.files.stores.${name}.max_file_size_bytes`, size);
  }

  const secrets = isPlainObject(resources.secrets) && Array.isArray(resources.secrets.required) ? resources.secrets.required : [];
  if (secrets.length > 0) feature("secrets.enabled", "resources.secrets.required", secrets.length);
  limit("secrets.required.max", "resources.secrets.required", secrets.length);

  const jobs = objectEntries(resources.jobs);
  for (const [name, job] of jobs) {
    const spec = isPlainObject(job) ? job : {};
    const trigger = spec.trigger ?? "manual";
    if (trigger === "manual") {
      feature("jobs.manual", `resources.jobs.${name}.trigger`, "manual");
    } else if (trigger === "schedule" && typeof spec.schedule === "string") {
      feature("jobs.scheduled", `resources.jobs.${name}.trigger`, "schedule");
      requirements.push({ kind: "schedule", key: "jobs.schedule.allowed", manifest_path: `resources.jobs.${name}.schedule`, value: spec.schedule });
    }
  }
  limit("jobs.declared.max", "resources.jobs", jobs.length);

  const webhooks = objectEntries(resources.webhooks);
  if (webhooks.length > 0) feature("webhooks.enabled", "resources.webhooks", webhooks.length);
  for (const [name, webhook] of webhooks) {
    const provider = isPlainObject(webhook) ? webhook.provider : undefined;
    if (provider === "generic_hmac" || provider === "github") {
      feature(`webhooks.provider.${provider}`, `resources.webhooks.${name}.provider`, provider);
    }
  }
  limit("webhooks.declared.max", "resources.webhooks", webhooks.length);

  return requirements;
}

export function releaseRequirements(fileCount: number, bundleBytes: number): Requirement[] {
  return [
    { kind: "release", key: "release.file_count.max", manifest_path: "release.file_count", value: fileCount },
    { kind: "release", key: "release.bundle_bytes.max", manifest_path: "release.bundle_bytes", value: bundleBytes }
  ];
}

/** Returns the requirements the given entitlements do not allow, as violations. */
export function evaluateRequirements(requirements: Requirement[], planKey: PlanKey, config: EntitlementConfig): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const fallback = planData().plans[planKey];
  for (const requirement of requirements) {
    if (requirement.kind === "feature") {
      if (config.features[requirement.key] === true) continue;
      const requiredPlan = requiredPlanFor(requirement);
      findings.push({
        kind: "manifest_feature",
        manifest_path: requirement.manifest_path,
        feature_key: requirement.key,
        value: requirement.value,
        allowed: false,
        plan_key: planKey,
        required_plan_key: requiredPlan,
        message: `${featureLabel(requirement.key)}: ${planRequirementText(requiredPlan)}.`
      });
      continue;
    }

    const allowed =
      requirement.kind === "release"
        ? (config.release_limits?.[requirement.key] !== undefined ? config.release_limits[requirement.key] : fallback?.release_limits[requirement.key]) ?? null
        : (config.manifest_limits[requirement.key] !== undefined ? config.manifest_limits[requirement.key] : fallback?.manifest_limits[requirement.key]) ?? null;
    if (requirementAllowed(requirement, allowed)) continue;
    const requiredPlan = requiredPlanFor(requirement);
    findings.push({
      kind: requirement.kind === "release" ? "release_limit" : "manifest_limit",
      manifest_path: requirement.manifest_path,
      limit_key: requirement.key,
      value: requirement.value,
      allowed,
      plan_key: planKey,
      required_plan_key: requiredPlan,
      message: limitMessage(requirement, allowed, planKey, requiredPlan)
    });
  }
  return findings;
}

/** The lowest self-serve plan that allows this requirement, or SUPPORT_ONLY_PLAN_KEY when none does (as the API reports it). */
export function requiredPlanFor(requirement: Requirement): PlanKey {
  const data = planData();
  return data.plan_order.find((planKey) => planAllows(requirement, data.plans[planKey])) ?? SUPPORT_ONLY_PLAN_KEY;
}

/** The lowest self-serve plan that allows every requirement, or SUPPORT_ONLY_PLAN_KEY when none does. */
export function minimumPlanFor(requirements: Requirement[]): PlanKey {
  const data = planData();
  return data.plan_order.find((planKey) => requirements.every((requirement) => planAllows(requirement, data.plans[planKey]))) ?? SUPPORT_ONLY_PLAN_KEY;
}

function planAllows(requirement: Requirement, plan: PlanEntry): boolean {
  if (requirement.kind === "feature") return plan.features[requirement.key] === true;
  const allowed = requirement.kind === "release" ? plan.release_limits[requirement.key] : plan.manifest_limits[requirement.key];
  return requirementAllowed(requirement, allowed ?? null);
}

function requirementAllowed(requirement: Requirement, allowed: ManifestLimitValue): boolean {
  if (allowed === null) return true;
  if (Array.isArray(allowed)) {
    return typeof requirement.value === "string" && allowed.includes(requirement.value);
  }
  return typeof requirement.value === "number" && requirement.value <= allowed;
}

const FEATURE_LABELS: Record<string, string> = {
  "runtime.static": "Static files",
  "runtime.server": "Server runtime",
  private_apps: "Private apps",
  "auth.app_users": "App-user sign-in",
  "auth.public_signup": "Public app-user signup",
  "auth.email_verification": "App-user email verification",
  "data.enabled": "Data collections",
  "files.enabled": "File stores",
  "files.private_stores": "Private file stores",
  "secrets.enabled": "Secrets",
  "jobs.manual": "Manual jobs",
  "jobs.scheduled": "Scheduled jobs",
  "webhooks.enabled": "Webhooks",
  "webhooks.provider.generic_hmac": "Generic HMAC webhooks",
  "webhooks.provider.github": "GitHub webhooks"
};

const LIMIT_LABELS: Record<string, string> = {
  "auth.roles.max": "App-user roles",
  "data.collections.max": "Data collections",
  "data.indexes_per_collection.max": "Indexes in this collection",
  "files.stores.max": "File stores",
  "files.max_upload_size_bytes.max": "File store max upload size (bytes)",
  "secrets.required.max": "Required secrets",
  "jobs.declared.max": "Jobs",
  "jobs.schedule.allowed": "Job schedule",
  "webhooks.declared.max": "Webhooks",
  "release.file_count.max": "Release file count",
  "release.bundle_bytes.max": "Release size (bytes)"
};

function featureLabel(key: string): string {
  return FEATURE_LABELS[key] ?? key;
}

function limitMessage(requirement: Requirement, allowed: ManifestLimitValue, planKey: PlanKey, requiredPlan: PlanKey): string {
  const label = LIMIT_LABELS[requirement.key] ?? requirement.key;
  const plan = planDisplayName(planKey);
  const upgrade = isSelfServePlan(requiredPlan) ? `Requires ${planDisplayName(requiredPlan)}.` : "This value is not available on self-serve plans; contact support.";
  if (Array.isArray(allowed)) {
    const allowedText = allowed.length === 0 ? "no scheduled jobs" : allowed.join(", ");
    return `${label}: ${String(requirement.value)} is not allowed on ${plan} (allowed: ${allowedText}). ${upgrade}`;
  }
  return `${label}: ${String(requirement.value)} exceeds the ${plan} limit of ${String(allowed)}. ${upgrade}`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function validationExitCode(report: ValidationReport): number {
  if (report.errors.length > 0) return 1;
  if (report.violations.length > 0) return 2;
  return 0;
}

export function validationJson(report: ValidationReport): Record<string, unknown> {
  return {
    ok: report.ok,
    plan: report.plan,
    plan_source: report.plan_source,
    required_plan_key: report.required_plan_key,
    violations: report.violations,
    plan_gated: report.plan_gated,
    errors: report.errors,
    warnings: report.warnings,
    manifest_file: report.manifest_file,
    release: report.release,
    embed_origins: report.embed_origins
  };
}

export function formatValidationReport(report: ValidationReport, context: { dir: string; command?: string }): string {
  const lines: string[] = [];
  lines.push(report.ok ? "Validation passed." : "Validation failed.");
  if (report.manifest_file) lines.push(`manifest=${path.join(context.dir, report.manifest_file)}`);
  if (report.plan) {
    lines.push(`plan=${report.plan}`);
    if (report.plan_source) lines.push(`plan_source=${report.plan_source}`);
  } else {
    lines.push("plan=none");
  }
  if (report.required_plan_key !== null) {
    lines.push(`required_plan=${report.required_plan_key}`);
  }
  lines.push(`release_files=${report.release.file_count}`);
  lines.push(`release_bytes=${report.release.bundle_bytes}`);
  if (report.embed_origins !== null && report.embed_origins.length > 0) {
    lines.push(`embed_origins=${report.embed_origins.join(",")}`);
  }
  for (const warning of report.warnings) {
    lines.push(formatWarning(warning));
  }

  for (const error of report.errors) {
    lines.push("");
    lines.push(`error=${error.code}`);
    if (error.manifest_path) lines.push(`manifest_path=${error.manifest_path}`);
    if (error.file !== undefined) lines.push(`file=${error.file}`);
    lines.push(`message=${error.message}`);
  }

  for (const violation of report.violations) {
    lines.push("");
    lines.push(...findingLines(violation, true));
  }

  if (!report.plan && report.plan_gated.length > 0) {
    lines.push("");
    lines.push("Plan-gated features (not enforced without --plan; the Free plan does not include these):");
    for (const finding of report.plan_gated) {
      lines.push("");
      lines.push(...findingLines(finding, false));
    }
  }

  const required = report.required_plan_key;
  if (report.violations.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    if (required !== null && isSelfServePlan(required)) {
      lines.push(`- Change or remove the manifest values above, or use a plan that includes them (${planDisplayName(required)}).`);
      lines.push(`- Check against that plan: userland validate ${context.dir} --plan ${required}`);
    } else {
      lines.push("- Change or remove the manifest values above. Some of them are not available on self-serve plans; contact support if you need them.");
    }
    lines.push("- The Userland API enforces plan limits authoritatively when you publish.");
    lines.push(`Docs: ${LIMITS_DOCS_URL}`);
  } else if (report.errors.length > 0) {
    lines.push("");
    lines.push("Docs: https://docs.userland.fun/reference/resource-manifest");
  } else if (!report.plan && required !== null && required !== "free") {
    lines.push("");
    lines.push(
      isSelfServePlan(required)
        ? `This app needs the ${planDisplayName(required)} plan or higher. Check a specific plan with --plan <plan>.`
        : "This app uses features or limits that are not available on self-serve plans; contact support."
    );
    lines.push(`Docs: ${LIMITS_DOCS_URL}`);
  }
  // File names come from the app folder, so show any control characters in them as visible escapes.
  return `${lines.map(terminalSafe).join("\n")}\n`;
}

export function formatWarning(warning: ValidationIssue): string {
  return terminalSafe(`warning=${warning.code}${warning.manifest_path ? ` manifest_path=${warning.manifest_path}` : ""}${warning.file !== undefined ? ` file=${warning.file}` : ""} ${warning.message}`);
}

function findingLines(finding: ValidationFinding, includeAllowed: boolean): string[] {
  const lines = [`manifest_path=${finding.manifest_path}`];
  if (finding.feature_key) lines.push(`feature=${finding.feature_key}`);
  if (finding.limit_key) lines.push(`limit=${finding.limit_key}`);
  lines.push(`value=${formatValue(finding.value)}`);
  if (includeAllowed) lines.push(`allowed=${formatAllowedValue(finding.allowed)}`);
  lines.push(`requires=${finding.required_plan_key}`);
  lines.push(`message=${finding.message}`);
  return lines;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

function formatAllowedValue(value: ValidationFinding["allowed"]): string {
  if (value === null) return "unlimited";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(",");
  return String(value);
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema (draft 2020-12 subset used by the manifest schema)
// ---------------------------------------------------------------------------

interface SchemaError {
  path: Array<string | number>;
  keyword: string;
  message: string;
}

const PATTERN_DESCRIPTIONS: Record<string, string> = {
  "^[a-z][a-z0-9-]{0,63}$": "must be 1-64 lowercase letters, numbers, or hyphens, starting with a letter",
  "^[a-z][a-z0-9_]{0,63}$": "must be 1-64 lowercase letters, numbers, or underscores, starting with a letter",
  "^(?!USERLAND_)(?!CF_)(?!CLOUDFLARE_)[A-Z][A-Z0-9_]{0,63}$": "must be 1-64 uppercase letters, numbers, or underscores, starting with a letter, and must not start with USERLAND_, CF_, or CLOUDFLARE_",
  "^(?!/)(?!.*\\\\)(?!_userland(?:/|$))(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*//).+$": "must be a relative path without a leading /, backslashes, . or .. segments, empty segments, or _userland/",
  "^role:[a-z][a-z0-9-]{0,63}$": "must look like role:<role-name>",
  "^job:[a-z][a-z0-9-]{0,63}$": "must look like job:<job-name>",
  "^https://(?:\\*\\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?$":
    "must start with https:// in lowercase letters, then a domain name and an optional port (a leading *. covers subdomains)",
  "^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+/[!#$%&'*+\\-.^_`|~0-9A-Za-z]+(?:[\\t ]*;[\\t ]*[!#$%&'*+\\-.^_`|~0-9A-Za-z]+=(?:\"[\\t\\x20\\x21\\x23-\\x2b\\x2d-\\x5b\\x5d-\\x7e]*\"|[!#$%&'*+\\-.^_`|~0-9A-Za-z]+))*$": "must be a MIME type such as text/html or image/png"
};

/** Keywords validateAgainstSchema understands; tests fail if the published schema starts using others. */
export const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "default",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "not",
  "anyOf",
  "oneOf"
]);

const patternCache = new Map<string, RegExp>();

export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationIssue[] {
  return schemaErrors(value, schema).map(toIssue);
}

function schemaErrors(value: unknown, schema: JsonSchema): SchemaError[] {
  return validateNode(value, schema, schema, []);
}

function toIssue(error: SchemaError): ValidationIssue {
  return { code: "schema", manifest_path: formatPath(error.path), message: error.message };
}

function validateNode(value: unknown, schema: unknown, root: JsonSchema, at: Array<string | number>): SchemaError[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [{ path: at, keyword: "false", message: "is not allowed" }];
  const node = schema as JsonSchema;

  if (typeof node.$ref === "string") {
    return validateNode(value, resolveRef(root, node.$ref), root, at);
  }

  const errors: SchemaError[] = [];
  if (node.type !== undefined && !matchesType(value, node.type as string)) {
    return [{ path: at, keyword: "type", message: `must be ${article(node.type as string)}` }];
  }
  if (node.const !== undefined && value !== node.const) {
    errors.push({ path: at, keyword: "const", message: `must be ${JSON.stringify(node.const)}` });
  }
  if (Array.isArray(node.enum) && !node.enum.some((option) => option === value)) {
    errors.push({ path: at, keyword: "enum", message: `must be one of: ${node.enum.map(String).join(", ")}` });
  }

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      errors.push({ path: at, keyword: "minLength", message: node.minLength === 1 ? "must not be empty" : `must be at least ${node.minLength} characters` });
    }
    if (typeof node.maxLength === "number" && value.length > node.maxLength) {
      errors.push({ path: at, keyword: "maxLength", message: `must be at most ${node.maxLength} characters` });
    }
    if (typeof node.pattern === "string" && !compilePattern(node.pattern).test(value)) {
      errors.push({ path: at, keyword: "pattern", message: `${JSON.stringify(value)} ${PATTERN_DESCRIPTIONS[node.pattern] ?? `must match ${node.pattern}`}` });
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      errors.push({ path: at, keyword: "minimum", message: `must be at least ${node.minimum}` });
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      errors.push({ path: at, keyword: "maximum", message: `must be at most ${node.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      errors.push({ path: at, keyword: "minItems", message: `must contain at least ${node.minItems} item${node.minItems === 1 ? "" : "s"}` });
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      errors.push({ path: at, keyword: "maxItems", message: `must contain at most ${node.maxItems} item${node.maxItems === 1 ? "" : "s"}` });
    }
    if (node.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push({ path: at, keyword: "uniqueItems", message: `must not contain duplicates (${formatValue(item)})` });
          break;
        }
        seen.add(key);
      }
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => errors.push(...validateNode(item, node.items, root, [...at, index])));
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    for (const required of Array.isArray(node.required) ? (node.required as string[]) : []) {
      if (!(required in value)) {
        errors.push({ path: [...at, required], keyword: "required", message: "is required" });
      }
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      if (node.propertyNames !== undefined) {
        const nameErrors = validateNode(key, node.propertyNames, root, [...at, key]);
        if (nameErrors.length > 0) {
          errors.push({ path: [...at, key], keyword: "propertyNames", message: `name ${nameErrors.map((error) => error.message.replace(`${JSON.stringify(key)} `, "")).join("; ")}` });
          continue;
        }
      }
      if (key in properties) {
        errors.push(...validateNode(propertyValue, properties[key], root, [...at, key]));
      } else if (node.additionalProperties === false) {
        const allowed = Object.keys(properties);
        errors.push({ path: [...at, key], keyword: "additionalProperties", message: `is not an allowed key${allowed.length > 0 ? ` (allowed: ${allowed.join(", ")})` : ""}` });
      } else if (node.additionalProperties !== undefined && node.additionalProperties !== true) {
        errors.push(...validateNode(propertyValue, node.additionalProperties, root, [...at, key]));
      }
    }
  }

  if (node.not !== undefined && validateNode(value, node.not, root, at).length === 0) {
    const reserved = isPlainObject(node.not) && Array.isArray(node.not.enum);
    errors.push({ path: at, keyword: "not", message: reserved ? `${JSON.stringify(value)} is reserved` : "is not allowed" });
  }

  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf.map((branch) => validateNode(value, branch, root, at));
    if (!branches.some((branchErrors) => branchErrors.length === 0)) {
      errors.push(...combineBranchErrors(branches, at));
    }
  }

  if (Array.isArray(node.oneOf)) {
    const branches = node.oneOf.map((branch) => validateNode(value, branch, root, at));
    const matches = branches.filter((branchErrors) => branchErrors.length === 0).length;
    if (matches === 0) {
      errors.push(...combineBranchErrors(branches, at));
    } else if (matches > 1) {
      errors.push({ path: at, keyword: "oneOf", message: "matches more than one allowed shape" });
    }
  }

  return errors;
}

function combineBranchErrors(branches: SchemaError[][], at: Array<string | number>): SchemaError[] {
  // When every branch fails with one error on this same value, merge the alternatives.
  if (branches.every((branchErrors) => branchErrors.length === 1 && samePath(branchErrors[0].path, at) && branchErrors[0].keyword !== "type")) {
    const messages = branches.map((branchErrors) => branchErrors[0].message.replace(/^"(?:[^"\\]|\\.)*" /u, ""));
    const [first, ...rest] = messages;
    return [{ path: at, keyword: "anyOf", message: [first, ...rest.map((message) => message.replace(/^must /u, ""))].join(", or ") }];
  }
  // Otherwise report the branch that looks like the intended shape: mismatched
  // discriminators (type, or const/enum on a direct property) weigh more than other errors.
  let best = branches[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const branchErrors of branches) {
    const score = branchErrors.reduce((total, error) => {
      const discriminator = (error.keyword === "type" && samePath(error.path, at)) || ((error.keyword === "const" || error.keyword === "enum") && error.path.length === at.length + 1);
      return total + (discriminator ? 10 : 1);
    }, 0);
    if (score < bestScore) {
      best = branchErrors;
      bestScore = score;
    }
  }
  return best;
}

function samePath(left: Array<string | number>, right: Array<string | number>): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function resolveRef(root: JsonSchema, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported schema reference: ${ref}`);
  }
  let current: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    current = isPlainObject(current) ? current[part.replace(/~1/gu, "/").replace(/~0/gu, "~")] : undefined;
  }
  if (current === undefined) {
    throw new Error(`Unresolved schema reference: ${ref}`);
  }
  return current;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function article(type: string): string {
  return type === "array" || type === "object" || type === "integer" ? `an ${type}` : `a ${type}`;
}

function compilePattern(pattern: string): RegExp {
  let compiled = patternCache.get(pattern);
  if (!compiled) {
    // Schema patterns use ECMA-262 syntax without the unicode flag (they contain identity escapes).
    compiled = new RegExp(pattern);
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

function formatPath(parts: Array<string | number>): string {
  return parts.reduce<string>((output, part) => (typeof part === "number" ? `${output}[${part}]` : output ? `${output}.${part}` : part), "");
}

function objectEntries(value: unknown): Array<[string, unknown]> {
  return isPlainObject(value) ? Object.entries(value) : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

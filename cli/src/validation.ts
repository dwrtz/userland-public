import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

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
  required_plan_key: PlanKey | null;
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
}

export interface ValidateOptions {
  planKey?: PlanKey;
  planSource?: "flag" | "account";
  /** Effective account entitlements; defaults to the public plan table entry for planKey. */
  entitlements?: EntitlementConfig;
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
const CLI_MANIFEST_KEYS = new Set(["files", "message", "provenance"]);
const RESERVED_RESOURCE_NAMES = new Set(["_userland", "system", "auth", "session", "sessions", "secrets", "runtime"]);
const CONTENT_TYPE_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+(?:\s*;\s*[!#$%&'*+\-.^_`|~0-9a-z]+=(?:"[^"]*"|[!#$%&'*+\-.^_`|~0-9a-z]+))*$/iu;

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

export function publicPlanKeys(): PlanKey[] {
  return [...planData().plan_order];
}

/** Returns the canonical public plan key, or undefined when the value is not a public plan. */
export function normalizePlanKey(value: string): PlanKey | undefined {
  const data = planData();
  const lowered = value.trim().toLowerCase();
  const key = data.plan_aliases[lowered] ?? lowered;
  return data.plan_order.includes(key) ? key : undefined;
}

export function planDisplayName(planKey: PlanKey | null): string {
  if (planKey === null) return "no public plan";
  return planData().plans[planKey]?.display_name ?? planKey;
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
  const report: ValidationReport = {
    ok: false,
    plan: options.planKey ?? null,
    plan_source: options.planKey ? options.planSource ?? "flag" : null,
    required_plan_key: null,
    violations: [],
    plan_gated: [],
    errors: [],
    warnings: [],
    manifest_file: null,
    release: { file_count: 0, bundle_bytes: 0 }
  };
  const absoluteRoot = path.resolve(rootDir);
  const stat = await fs.stat(absoluteRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    report.errors.push({ code: "directory_not_found", manifest_path: "", message: `Directory not found: ${rootDir}` });
    return report;
  }

  const loaded = await loadManifestFile(absoluteRoot, report);
  if (loaded === undefined) {
    return finish(report);
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

  const cliKeyErrors = validateCliKeys(cliKeys);
  const manifestErrors = [...validateManifestDocument(manifestDocument), ...cliKeyErrors];
  report.errors.push(...manifestErrors);

  const releaseFiles = await collectReleaseFiles(absoluteRoot, document, report);
  await checkRuntimePaths(absoluteRoot, manifestDocument, releaseFiles, report);

  if (manifestErrors.length === 0) {
    const input: ManifestInput = {
      app: manifestDocument.app as Record<string, unknown>,
      runtime: manifestDocument.runtime as Record<string, unknown>,
      resources: (manifestDocument.resources as Record<string, unknown> | undefined) ?? {}
    };
    const requirements = [
      ...analyzeManifestRequirements(input),
      ...releaseRequirements(report.release.file_count, report.release.bundle_bytes)
    ];
    report.required_plan_key = minimumPlanFor(requirements);
    report.plan_gated = evaluateRequirements(requirements, "free", planData().plans.free);
    if (options.planKey) {
      const config = options.entitlements ?? planData().plans[options.planKey];
      if (!config) {
        throw new Error(`Unknown plan: ${options.planKey}`);
      }
      report.violations = evaluateRequirements(requirements, options.planKey, config);
    }
  }

  return finish(report);
}

function finish(report: ValidationReport): ValidationReport {
  report.ok = report.errors.length === 0 && report.violations.length === 0;
  return report;
}

async function loadManifestFile(rootDir: string, report: ValidationReport): Promise<{ document: Record<string, unknown>; file: string | null } | undefined> {
  for (const name of [MANIFEST_FILE, LEGACY_MANIFEST_FILE]) {
    const filePath = path.join(rootDir, name);
    const contents = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return undefined;
      throw error;
    });
    if (contents === undefined) continue;
    report.manifest_file = name;
    if (name === LEGACY_MANIFEST_FILE) {
      report.warnings.push({ code: "legacy_manifest", manifest_path: "", message: `Using legacy ${LEGACY_MANIFEST_FILE}; rename it to ${MANIFEST_FILE}.` });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      report.errors.push({ code: "invalid_json", manifest_path: "", message: `${name} is not valid JSON: ${(error as Error).message}` });
      return undefined;
    }
    if (!isPlainObject(parsed)) {
      report.errors.push({ code: "invalid_manifest", manifest_path: "", message: `${name} must contain a JSON object.` });
      return undefined;
    }
    return { document: parsed, file: name };
  }
  report.warnings.push({
    code: "missing_manifest",
    manifest_path: "",
    message: `No ${MANIFEST_FILE} found; the CLI publishes every file with default app and runtime settings.`
  });
  return { document: {}, file: null };
}

/** Schema validation plus the cross-field rules the API enforces for app, runtime, and resources. */
export function validateManifestDocument(document: Record<string, unknown>): ValidationIssue[] {
  const schemaErrors = validateAgainstSchema(document, manifestSchema());
  return schemaErrors.length > 0 ? schemaErrors : semanticManifestErrors(document);
}

function validateCliKeys(cliKeys: Record<string, unknown>): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (cliKeys.message !== undefined && typeof cliKeys.message !== "string") {
    errors.push({ code: "schema", manifest_path: "message", message: "must be a string" });
  }
  if (cliKeys.provenance !== undefined && !isPlainObject(cliKeys.provenance)) {
    errors.push({ code: "schema", manifest_path: "provenance", message: "must be an object" });
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
            errors.push({ code: "schema", manifest_path: `${entryPath}.${key}`, message: "is not an allowed key" });
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
  return errors;
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
    const target = webhook.deliver_to === "job" ? webhook.job : typeof webhook.deliver_to === "string" && webhook.deliver_to.startsWith("job:") ? webhook.deliver_to.slice("job:".length) : undefined;
    if (typeof target === "string" && !(target in jobs)) {
      const targetPath = webhook.deliver_to === "job" ? "job" : "deliver_to";
      errors.push({ code: "invalid_resource_manifest", manifest_path: `resources.webhooks.${webhookName}.${targetPath}`, message: `webhook job target ${target} is not declared in resources.jobs` });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Release files and runtime paths
// ---------------------------------------------------------------------------

/** Lists the files `apps publish` would upload, mirroring its selection rules. */
export async function listReleaseFiles(rootDir: string, document: Record<string, unknown>): Promise<ReleaseFileEntry[]> {
  const manifestFiles = Array.isArray(document.files) ? document.files : null;
  if (manifestFiles && manifestFiles.length > 0) {
    return manifestFiles
      .filter((entry): entry is { path: string; content_type?: unknown } => isPlainObject(entry) && typeof entry.path === "string")
      .map((entry) => ({
        path: entry.path,
        absolutePath: path.join(rootDir, entry.path),
        ...(typeof entry.content_type === "string" ? { contentType: entry.content_type } : {})
      }));
  }
  return (await walk(rootDir))
    .filter((filePath) => !isManifestFile(filePath))
    .sort()
    .map((filePath) => ({
      path: path.relative(rootDir, filePath).split(path.sep).join("/"),
      absolutePath: filePath
    }));
}

async function collectReleaseFiles(rootDir: string, document: Record<string, unknown>, report: ValidationReport): Promise<Set<string>> {
  const bundle = planData().bundle_limits;
  const entries = await listReleaseFiles(rootDir, document);
  const fromManifest = Array.isArray(document.files) && document.files.length > 0;
  const seen = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;

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
    const fileStat = await fs.stat(entry.absolutePath).catch(() => null);
    if (!fileStat?.isFile()) {
      report.errors.push({ code: "missing_file", manifest_path: entryPath, file: entry.path, message: "does not exist or is not a file" });
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
  if (!fromManifest) {
    for (const directory of [".git", "node_modules"]) {
      if (Array.from(seen).some((filePath) => filePath === directory || filePath.startsWith(`${directory}/`))) {
        report.warnings.push({ code: "unexpected_release_files", manifest_path: "", message: `${directory}/ would be uploaded; publish a build directory or list files in manifest.userland.json files.` });
      }
    }
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
  if (releasePath.startsWith("/") || /^[A-Za-z]:/u.test(releasePath)) return "absolute paths are not allowed; use a path relative to the app directory";
  if (releasePath.includes("\\")) return "backslashes are not allowed; use / separators";
  const parts = releasePath.split("/");
  if (parts.some((part) => part === "..")) return "parent directory segments (..) are not allowed";
  if (parts.some((part) => part === "" || part === ".")) return "empty or . segments are not allowed";
  if (releasePath === "_userland" || releasePath.startsWith("_userland/")) return "_userland/ is reserved by Userland";
  return undefined;
}

export function isManifestFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return basename === MANIFEST_FILE || basename === LEGACY_MANIFEST_FILE;
}

export async function walk(dir: string): Promise<string[]> {
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
        message: requiredPlan === null ? `${featureLabel(requirement.key)}: not available on any public plan.` : `${featureLabel(requirement.key)}: requires ${planDisplayName(requiredPlan)} or higher.`
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

/** The lowest public plan that allows this requirement, or null when none does. */
export function requiredPlanFor(requirement: Requirement): PlanKey | null {
  const data = planData();
  return data.plan_order.find((planKey) => planAllows(requirement, data.plans[planKey])) ?? null;
}

/** The lowest public plan that allows every requirement, or null when none does. */
export function minimumPlanFor(requirements: Requirement[]): PlanKey | null {
  const data = planData();
  return data.plan_order.find((planKey) => requirements.every((requirement) => planAllows(requirement, data.plans[planKey]))) ?? null;
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

function limitMessage(requirement: Requirement, allowed: ManifestLimitValue, planKey: PlanKey, requiredPlan: PlanKey | null): string {
  const label = LIMIT_LABELS[requirement.key] ?? requirement.key;
  const plan = planDisplayName(planKey);
  const upgrade = requiredPlan === null ? "No public plan allows this value." : `Requires ${planDisplayName(requiredPlan)} or higher.`;
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
    release: report.release
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
  if (report.errors.length === 0 || report.required_plan_key !== null) {
    lines.push(`required_plan=${report.required_plan_key ?? "unavailable"}`);
  }
  lines.push(`release_files=${report.release.file_count}`);
  lines.push(`release_bytes=${report.release.bundle_bytes}`);
  for (const warning of report.warnings) {
    lines.push(`warning=${warning.code}${warning.manifest_path ? ` manifest_path=${warning.manifest_path}` : ""} ${warning.message}`);
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

  if (report.violations.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    lines.push(`- Change or remove the manifest values above, or use a plan that includes them${report.required_plan_key ? ` (${report.required_plan_key})` : ""}.`);
    if (report.required_plan_key) {
      lines.push(`- Check against that plan: userland validate ${context.dir} --plan ${report.required_plan_key}`);
    }
    lines.push("- The Userland API enforces plan limits authoritatively when you publish.");
    lines.push("Docs: https://docs.userland.fun/reference/limits");
  } else if (report.errors.length > 0) {
    lines.push("");
    lines.push("Docs: https://docs.userland.fun/reference/resource-manifest");
  } else if (!report.plan && report.required_plan_key && report.required_plan_key !== "free") {
    lines.push("");
    lines.push(`This app needs the ${planDisplayName(report.required_plan_key)} plan or higher. Check a specific plan with --plan <plan>.`);
  }
  return `${lines.join("\n")}\n`;
}

function findingLines(finding: ValidationFinding, includeAllowed: boolean): string[] {
  const lines = [`manifest_path=${finding.manifest_path}`];
  if (finding.feature_key) lines.push(`feature=${finding.feature_key}`);
  if (finding.limit_key) lines.push(`limit=${finding.limit_key}`);
  lines.push(`value=${formatValue(finding.value)}`);
  if (includeAllowed) lines.push(`allowed=${formatAllowedValue(finding.allowed)}`);
  lines.push(`requires=${finding.required_plan_key ?? "unavailable"}`);
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
  "^job:[a-z][a-z0-9-]{0,63}$": "must look like job:<job-name>"
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
  return validateNode(value, schema, schema, []).map((error) => ({
    code: "schema",
    manifest_path: formatPath(error.path),
    message: error.message
  }));
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

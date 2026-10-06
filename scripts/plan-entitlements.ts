// Plan metadata for catalog entries (`required_plan` and `paid_features`).
//
// There is no plan table here. Plan rules come from the CLI's plan module
// (cli/src/validation.ts), which reads schemas/plans-v0.json, the public plan
// artifact generated from the platform's plan configuration. The catalog
// therefore reports exactly what `userland validate <dir>` reports:
// `required_plan` is its `required_plan_key` and `paid_features` are the
// feature and limit keys it lists under `plan_gated`.
import {
  analyzeManifestRequirements,
  evaluateRequirements,
  minimumPlanFor,
  planData,
  publicPlanKeys,
  releaseRequirements,
  type Requirement,
  type ValidationFinding,
  type ValidationReport
} from "../cli/src/validation.js";

type Json = Record<string, unknown>;

export interface PlanMetadata {
  /** Lowest self-serve plan that can publish the app, or "internal" when none can. */
  required_plan: string;
  /** Feature and limit keys the Free plan does not allow, in the order the CLI reports them. */
  paid_features: string[];
}

/** Self-serve plans, lowest first (Free plus the plans on sale). */
export const SELF_SERVE_PLANS: readonly string[] = publicPlanKeys();
const FREE_PLAN = SELF_SERVE_PLANS[0]!;

// Features a manifest can turn on (analyzeManifestRequirements reports only
// these). Account-level features such as custom_domains or app_analytics are
// not manifest features and never appear in paid_features.
const MANIFEST_FEATURE_PREFIXES = ["runtime", "auth", "data", "files", "secrets", "jobs", "webhooks"];

/**
 * Keys that can appear in `paid_features`: the manifest features Free does
 * not include, plus every manifest and release limit key.
 */
export function paidFeatureKeys(): Set<string> {
  const free = planData().plans[FREE_PLAN]!;
  const keys = new Set<string>();
  for (const [key, allowed] of Object.entries(free.features)) {
    if (!allowed && MANIFEST_FEATURE_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))) keys.add(key);
  }
  for (const key of Object.keys(free.manifest_limits)) keys.add(key);
  for (const key of Object.keys(free.release_limits)) keys.add(key);
  return keys;
}

/** Plan metadata for a manifest document, optionally including release size and file count. */
export function computePlanMetadata(manifest: Json, release?: { file_count: number; bundle_bytes: number }): PlanMetadata {
  const requirements: Requirement[] = analyzeManifestRequirements({
    app: asObject(manifest.app),
    runtime: asObject(manifest.runtime),
    resources: asObject(manifest.resources)
  });
  if (release) requirements.push(...releaseRequirements(release.file_count, release.bundle_bytes));
  const gated = evaluateRequirements(requirements, FREE_PLAN, planData().plans[FREE_PLAN]!);
  return { required_plan: minimumPlanFor(requirements), paid_features: findingKeys(gated) };
}

/** Plan metadata from a `validateAppDirectory` report: what `userland validate <dir> --json` prints. */
export function planMetadataFromReport(report: ValidationReport): PlanMetadata {
  if (report.required_plan_key === null) {
    throw new Error("The CLI could not compute the plan for this app; fix its validation errors first.");
  }
  return { required_plan: report.required_plan_key, paid_features: findingKeys(report.plan_gated) };
}

function findingKeys(findings: ValidationFinding[]): string[] {
  const keys: string[] = [];
  for (const finding of findings) {
    const key = finding.feature_key ?? finding.limit_key;
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Catalog capabilities that correspond to manifest resources. Other
// capabilities (rollback, transactions) describe behavior, not resources.
export function manifestCapabilities(manifest: Json): Set<string> {
  const runtime = asObject(manifest.runtime);
  const resources = asObject(manifest.resources);
  const found = new Set<string>();
  if (runtime.static_root) found.add("static");
  if (runtime.server_entry !== undefined) found.add("server");
  const auth = asObject(resources.auth);
  if (auth.mode && auth.mode !== "none") found.add("auth");
  if (Object.keys(asObject(asObject(resources.data).collections)).length > 0) found.add("data");
  if (Object.keys(asObject(asObject(resources.files).stores)).length > 0) found.add("files");
  const secrets = asObject(resources.secrets).required;
  if (Array.isArray(secrets) && secrets.length > 0) found.add("secrets");
  if (Object.keys(asObject(resources.jobs)).length > 0) found.add("jobs");
  if (Object.keys(asObject(resources.webhooks)).length > 0) found.add("webhooks");
  return found;
}

export const RESOURCE_CAPABILITIES = new Set(["static", "server", "auth", "data", "files", "secrets", "jobs", "webhooks"]);

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

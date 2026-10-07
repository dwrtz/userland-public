// Validation rules for catalog.json entries and examples/<slug>/example.json.
// Shared by scripts/validate-catalog.ts and its tests.
import { computePlanMetadata, manifestCapabilities, paidFeatureKeys, RESOURCE_CAPABILITIES, SELF_SERVE_PLANS, type PlanMetadata } from "./plan-entitlements.js";

export const allowedCapabilities = new Set(["static", "server", "auth", "data", "files", "secrets", "jobs", "webhooks", "rollback", "transactions"]);
const allowedDifficulty = new Set(["beginner", "intermediate", "advanced"]);
// Lowest self-serve plan that can publish the example (from the CLI's plan
// data, schemas/plans-v0.json). Plans that are not on sale and the
// operator-assigned "internal" plan are never valid here.
export const allowedPlans = new Set(SELF_SERVE_PLANS);
export const allowedLaunchRoles = new Set(["launch-example", "capability-fixture"]);
// Manifest feature and limit keys that plans above Free unlock. These are the
// feature_key / limit_key values `userland validate` lists under plan_gated and
// a publish 402 entitlement_required or plan_limit_exceeded error reports.
export const allowedPaidFeatures = paidFeatureKeys();
const requiredKeys = [
  "slug",
  "title",
  "summary",
  "path",
  "capabilities",
  "difficulty",
  "userland_api_version",
  "required_plan",
  "paid_features",
  "launch_role"
];
const launchExampleKeys = ["demo_url", "page_url"];
const allowedKeys = new Set([...requiredKeys, ...launchExampleKeys]);
const demoUrlPattern = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.userland\.link\/$/u;

export type CatalogEntry = {
  slug: string;
  title: string;
  summary: string;
  path: string;
  capabilities: string[];
  difficulty: string;
  userland_api_version: string;
  required_plan: string;
  paid_features: string[];
  launch_role: string;
  demo_url?: string;
  page_url?: string;
};

export function assertCatalogEntry(value: unknown): asserts value is CatalogEntry {
  assertObject(value, "Catalog entry must be an object.");
  for (const key of ["slug", "title", "summary", "path", "difficulty", "userland_api_version"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) throw new Error(`Catalog entry ${key} must be a non-empty string.`);
  }
  const entry = value as CatalogEntry;
  if (!/^[a-z][a-z0-9-]*$/u.test(entry.slug)) throw new Error(`Catalog slug is invalid: ${entry.slug}`);
  if (entry.path !== `examples/${entry.slug}`) throw new Error(`Catalog path must be examples/${entry.slug}.`);
  if (!allowedDifficulty.has(entry.difficulty)) throw new Error(`Unknown difficulty for ${entry.slug}: ${entry.difficulty}`);
  if (entry.userland_api_version !== "v0") throw new Error(`${entry.slug} must target Userland API v0.`);
  if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) throw new Error(`${entry.slug} must declare capabilities.`);
  for (const capability of entry.capabilities) {
    if (typeof capability !== "string" || !allowedCapabilities.has(capability)) throw new Error(`Unknown capability for ${entry.slug}: ${capability}`);
  }
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) throw new Error(`${entry.slug} has unknown catalog field: ${key}`);
  }
  assertPlanMetadata(entry);
  assertLaunchMetadata(entry);
}

// Checks that the entry's plan metadata and resource capabilities agree with
// the example's manifest. `computed` defaults to the CLI's plan analysis of the
// manifest alone; validate-catalog passes the full `userland validate` result,
// which also counts release size and file count.
export function assertEntryMatchesManifest(entry: CatalogEntry, manifest: Record<string, unknown>, computed: PlanMetadata = computePlanMetadata(manifest)): void {
  if (!allowedPlans.has(computed.required_plan)) {
    throw new Error(`${entry.slug} uses something no self-serve plan includes (${computed.paid_features.join(", ")}); catalog examples must publish on a self-serve plan.`);
  }
  if (entry.required_plan !== computed.required_plan) {
    throw new Error(`${entry.slug} required_plan is ${entry.required_plan}, but its manifest needs ${computed.required_plan} (because of ${computed.paid_features.join(", ") || "nothing paid"}).`);
  }
  const listed = [...entry.paid_features].sort();
  const expected = [...computed.paid_features].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    throw new Error(`${entry.slug} paid_features must be ${JSON.stringify(computed.paid_features)} to match its manifest; got ${JSON.stringify(entry.paid_features)}.`);
  }

  const fromManifest = manifestCapabilities(manifest);
  for (const capability of entry.capabilities) {
    if (RESOURCE_CAPABILITIES.has(capability) && !fromManifest.has(capability)) {
      throw new Error(`${entry.slug} lists capability ${capability}, but its manifest does not declare it.`);
    }
  }
  for (const capability of fromManifest) {
    // Nearly every example ships a static frontend; "static" is only required
    // when it is the example's whole point (no server).
    if (capability === "static" && fromManifest.has("server")) continue;
    if (!entry.capabilities.includes(capability)) {
      throw new Error(`${entry.slug} manifest declares ${capability}; add "${capability}" to its capabilities.`);
    }
  }
}

function assertPlanMetadata(entry: CatalogEntry): void {
  if (typeof entry.required_plan !== "string" || !allowedPlans.has(entry.required_plan)) {
    throw new Error(`${entry.slug} required_plan must be one of ${[...allowedPlans].join(", ")}; got ${JSON.stringify(entry.required_plan)}.`);
  }
  if (!Array.isArray(entry.paid_features)) throw new Error(`${entry.slug} paid_features must be an array.`);
  const seenFeatures = new Set<string>();
  for (const feature of entry.paid_features) {
    if (typeof feature !== "string" || !allowedPaidFeatures.has(feature)) throw new Error(`Unknown paid feature for ${entry.slug}: ${JSON.stringify(feature)}`);
    if (seenFeatures.has(feature)) throw new Error(`${entry.slug} lists paid feature ${feature} more than once.`);
    seenFeatures.add(feature);
  }
  if (entry.required_plan === "free" && entry.paid_features.length > 0) {
    throw new Error(`${entry.slug} requires the free plan but lists paid_features; paid_features must be [] for free examples.`);
  }
  if (entry.required_plan !== "free" && entry.paid_features.length === 0) {
    throw new Error(`${entry.slug} requires the ${entry.required_plan} plan but lists no paid_features.`);
  }
}

function assertLaunchMetadata(entry: CatalogEntry): void {
  if (typeof entry.launch_role !== "string" || !allowedLaunchRoles.has(entry.launch_role)) {
    throw new Error(`${entry.slug} launch_role must be one of ${[...allowedLaunchRoles].join(", ")}; got ${JSON.stringify(entry.launch_role)}.`);
  }
  if (entry.launch_role === "launch-example") {
    for (const key of launchExampleKeys) {
      if (typeof entry[key as keyof CatalogEntry] !== "string") throw new Error(`${entry.slug} is a launch-example and must set ${key}.`);
    }
  }
  if (entry.demo_url !== undefined) {
    if (typeof entry.demo_url !== "string" || !demoUrlPattern.test(entry.demo_url)) {
      throw new Error(`${entry.slug} demo_url must look like https://<demo-slug>.userland.link/; got ${JSON.stringify(entry.demo_url)}.`);
    }
  }
  if (entry.page_url !== undefined) {
    const expected = `https://userland.fun/examples/${entry.slug}/`;
    if (entry.page_url !== expected) throw new Error(`${entry.slug} page_url must be ${expected}; got ${JSON.stringify(entry.page_url)}.`);
  }
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
}

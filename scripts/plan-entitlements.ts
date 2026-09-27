// Snapshot of the Userland plan rules that decide which plan a resource
// manifest needs to publish. Used by scripts/validate-catalog.ts to check that
// each example's `required_plan` and `paid_features` match its manifest.
//
// SYNC: this mirrors the manifest-relevant parts of PLAN_CONFIG,
// analyzeManifestEntitlements, requiredPlanForFeature and
// requiredPlanForManifestLimit in the platform's plan rules. When plan limits
// change, update PLAN_RULES below. scripts/plan-entitlements.test.ts compares
// this snapshot with the platform source when USERLAND_REPO_DIR points at a
// checkout of the platform repo.

export const PLAN_ORDER = ["free", "starter", "business", "business_plus", "agency", "internal"] as const;
export type PlanKey = (typeof PLAN_ORDER)[number];

export const MANIFEST_FEATURE_KEYS = [
  "runtime.static",
  "runtime.server",
  "private_apps",
  "auth.app_users",
  "auth.public_signup",
  "auth.email_verification",
  "data.enabled",
  "files.enabled",
  "files.private_stores",
  "secrets.enabled",
  "jobs.manual",
  "jobs.scheduled",
  "webhooks.enabled",
  "webhooks.provider.generic_hmac",
  "webhooks.provider.github"
] as const;
export type ManifestFeatureKey = (typeof MANIFEST_FEATURE_KEYS)[number];

export const MANIFEST_LIMIT_KEYS = [
  "auth.roles.max",
  "data.collections.max",
  "data.indexes_per_collection.max",
  "files.stores.max",
  "files.max_upload_size_bytes.max",
  "secrets.required.max",
  "jobs.declared.max",
  "jobs.schedule.allowed",
  "webhooks.declared.max"
] as const;
export type ManifestLimitKey = (typeof MANIFEST_LIMIT_KEYS)[number];

type LimitValue = number | null | string[];

export interface PlanRules {
  features: Record<ManifestFeatureKey, boolean>;
  manifest_limits: Record<ManifestLimitKey, LimitValue>;
}

const MB = 1024 * 1024;

const PAID_FEATURES: Record<ManifestFeatureKey, boolean> = {
  "runtime.static": true,
  "runtime.server": true,
  private_apps: true,
  "auth.app_users": true,
  "auth.public_signup": true,
  "auth.email_verification": false,
  "data.enabled": true,
  "files.enabled": true,
  "files.private_stores": true,
  "secrets.enabled": true,
  "jobs.manual": true,
  "jobs.scheduled": true,
  "webhooks.enabled": true,
  "webhooks.provider.generic_hmac": true,
  "webhooks.provider.github": true
};

const TOP_LIMITS: Record<ManifestLimitKey, LimitValue> = {
  "auth.roles.max": 50,
  "data.collections.max": 100,
  "data.indexes_per_collection.max": 25,
  "files.stores.max": 50,
  "files.max_upload_size_bytes.max": 250 * MB,
  "secrets.required.max": 100,
  "jobs.declared.max": 100,
  "jobs.schedule.allowed": ["daily", "hourly", "every_15_minutes"],
  "webhooks.declared.max": 100
};

export const PLAN_RULES: Record<PlanKey, PlanRules> = {
  free: {
    features: {
      ...PAID_FEATURES,
      private_apps: false,
      "auth.public_signup": false,
      "files.private_stores": false,
      "jobs.scheduled": false,
      "webhooks.enabled": false,
      "webhooks.provider.generic_hmac": false,
      "webhooks.provider.github": false
    },
    manifest_limits: {
      "auth.roles.max": 2,
      "data.collections.max": 2,
      "data.indexes_per_collection.max": 2,
      "files.stores.max": 1,
      "files.max_upload_size_bytes.max": 5 * MB,
      "secrets.required.max": 1,
      "jobs.declared.max": 1,
      "jobs.schedule.allowed": [],
      "webhooks.declared.max": 0
    }
  },
  starter: {
    features: {
      ...PAID_FEATURES,
      private_apps: false,
      "auth.public_signup": false,
      "files.private_stores": false,
      "webhooks.provider.github": false
    },
    manifest_limits: {
      "auth.roles.max": 5,
      "data.collections.max": 10,
      "data.indexes_per_collection.max": 5,
      "files.stores.max": 3,
      "files.max_upload_size_bytes.max": 25 * MB,
      "secrets.required.max": 10,
      "jobs.declared.max": 5,
      "jobs.schedule.allowed": ["daily"],
      "webhooks.declared.max": 3
    }
  },
  business: {
    features: PAID_FEATURES,
    manifest_limits: {
      "auth.roles.max": 20,
      "data.collections.max": 25,
      "data.indexes_per_collection.max": 10,
      "files.stores.max": 10,
      "files.max_upload_size_bytes.max": 100 * MB,
      "secrets.required.max": 25,
      "jobs.declared.max": 20,
      "jobs.schedule.allowed": ["daily", "hourly", "every_15_minutes"],
      "webhooks.declared.max": 20
    }
  },
  business_plus: { features: PAID_FEATURES, manifest_limits: TOP_LIMITS },
  agency: { features: PAID_FEATURES, manifest_limits: TOP_LIMITS },
  internal: {
    features: Object.fromEntries(MANIFEST_FEATURE_KEYS.map((key) => [key, true])) as Record<ManifestFeatureKey, boolean>,
    manifest_limits: Object.fromEntries(MANIFEST_LIMIT_KEYS.map((key) => [key, null])) as Record<ManifestLimitKey, LimitValue>
  }
};

type Json = Record<string, any>;

type Requirement =
  | { kind: "feature"; key: ManifestFeatureKey }
  | { kind: "limit"; key: ManifestLimitKey; value: number | string[] };

// Mirrors analyzeManifestEntitlements: every feature a manifest uses and every
// limit it counts against, in the platform's order.
export function analyzeManifest(manifest: Json): Requirement[] {
  const app = (manifest.app ?? {}) as Json;
  const runtime = (manifest.runtime ?? {}) as Json;
  const resources = (manifest.resources ?? {}) as Json;
  const out: Requirement[] = [];
  const feature = (key: ManifestFeatureKey) => out.push({ kind: "feature", key });
  const limit = (key: ManifestLimitKey, value: number | string[]) => out.push({ kind: "limit", key, value });

  if (runtime.static_root) feature("runtime.static");
  if (runtime.server_entry !== undefined) feature("runtime.server");
  if (runtime.fallback === "server") feature("runtime.server");
  if (app.visibility === "private") feature("private_apps");

  const auth = resources.auth as Json | undefined;
  if (auth?.mode === "app_users") feature("auth.app_users");
  if (auth?.public_signup === true) feature("auth.public_signup");
  if (auth?.email_verification === true) feature("auth.email_verification");
  limit("auth.roles.max", Array.isArray(auth?.roles) ? auth.roles.length : 0);

  const collections = Object.values((resources.data?.collections ?? {}) as Record<string, Json>);
  if (collections.length > 0) feature("data.enabled");
  limit("data.collections.max", collections.length);
  limit("data.indexes_per_collection.max", Math.max(0, ...collections.map((collection) => collection.indexes?.length ?? 0)));

  const stores = Object.values((resources.files?.stores ?? {}) as Record<string, Json>);
  if (stores.length > 0) feature("files.enabled");
  if (stores.some((store) => store.public === false)) feature("files.private_stores");
  limit("files.stores.max", stores.length);
  const maxUpload = Math.max(0, ...stores.map((store) => store.max_file_size_bytes ?? 0));
  if (maxUpload > 0) limit("files.max_upload_size_bytes.max", maxUpload);

  const secrets = (resources.secrets?.required ?? []) as string[];
  if (secrets.length > 0) feature("secrets.enabled");
  limit("secrets.required.max", secrets.length);

  const jobs = Object.values((resources.jobs ?? {}) as Record<string, Json>);
  if (jobs.some((job) => job.trigger === "manual")) feature("jobs.manual");
  const schedules = Array.from(new Set(jobs.filter((job) => job.trigger === "schedule").map((job) => job.schedule).filter((value): value is string => typeof value === "string")));
  if (schedules.length > 0) {
    feature("jobs.scheduled");
    limit("jobs.schedule.allowed", schedules);
  }
  limit("jobs.declared.max", jobs.length);

  const webhooks = Object.values((resources.webhooks ?? {}) as Record<string, Json>);
  if (webhooks.length > 0) feature("webhooks.enabled");
  if (webhooks.some((webhook) => webhook.provider === "generic_hmac")) feature("webhooks.provider.generic_hmac");
  if (webhooks.some((webhook) => webhook.provider === "github")) feature("webhooks.provider.github");
  limit("webhooks.declared.max", webhooks.length);

  return out;
}

function limitAllows(allowed: LimitValue, value: number | string[]): boolean {
  if (allowed === null) return true;
  if (Array.isArray(allowed)) return Array.isArray(value) && value.every((item) => allowed.includes(item));
  return typeof value === "number" && value <= allowed;
}

function planIndexFor(requirement: Requirement): number {
  const index = PLAN_ORDER.findIndex((plan) =>
    requirement.kind === "feature" ? PLAN_RULES[plan].features[requirement.key] : limitAllows(PLAN_RULES[plan].manifest_limits[requirement.key], requirement.value)
  );
  return index === -1 ? PLAN_ORDER.length - 1 : index;
}

// The lowest plan that can publish the manifest, and the feature/limit keys
// that push it above Free (in the order the platform reports them).
export function computePlanMetadata(manifest: Json): { required_plan: PlanKey; paid_features: string[] } {
  let highest = 0;
  const paid: string[] = [];
  for (const requirement of analyzeManifest(manifest)) {
    const index = planIndexFor(requirement);
    if (index > 0 && !paid.includes(requirement.key)) paid.push(requirement.key);
    highest = Math.max(highest, index);
  }
  return { required_plan: PLAN_ORDER[highest]!, paid_features: paid };
}

// Catalog capabilities that correspond to manifest resources. Other
// capabilities (rollback, transactions) describe behavior, not resources.
export function manifestCapabilities(manifest: Json): Set<string> {
  const runtime = (manifest.runtime ?? {}) as Json;
  const resources = (manifest.resources ?? {}) as Json;
  const found = new Set<string>();
  if (runtime.static_root) found.add("static");
  if (runtime.server_entry !== undefined) found.add("server");
  if (resources.auth?.mode && resources.auth.mode !== "none") found.add("auth");
  if (Object.keys(resources.data?.collections ?? {}).length > 0) found.add("data");
  if (Object.keys(resources.files?.stores ?? {}).length > 0) found.add("files");
  if ((resources.secrets?.required ?? []).length > 0) found.add("secrets");
  if (Object.keys(resources.jobs ?? {}).length > 0) found.add("jobs");
  if (Object.keys(resources.webhooks ?? {}).length > 0) found.add("webhooks");
  return found;
}

export const RESOURCE_CAPABILITIES = new Set(["static", "server", "auth", "data", "files", "secrets", "jobs", "webhooks"]);

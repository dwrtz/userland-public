import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { planData, validateAppDirectory } from "../cli/src/validation.js";
import { allowedPaidFeatures, allowedPlans } from "./catalog-entry.js";
import { computePlanMetadata, paidFeatureKeys, planMetadataFromReport, SELF_SERVE_PLANS } from "./plan-entitlements.js";

const root = path.resolve(import.meta.dirname, "..");

function manifest(resources: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { app: { name: "Test", visibility: "public" }, runtime: { static_root: "public", server_entry: "server/index.js" }, resources, ...extra };
}

it("takes the plan list from the CLI's plan data: self-serve plans only", () => {
  expect(SELF_SERVE_PLANS).toEqual(planData().plan_order);
  expect([...allowedPlans]).toEqual(["free", "starter", "business", "business_plus"]);
  for (const retired of ["agency", "internal", "pro", "team"]) expect(allowedPlans.has(retired)).toBe(false);
});

it("allows only manifest and release keys as paid features", () => {
  const keys = paidFeatureKeys();
  expect(allowedPaidFeatures).toEqual(keys);
  for (const key of ["private_apps", "auth.public_signup", "files.private_stores", "jobs.scheduled", "webhooks.enabled", "webhooks.provider.generic_hmac", "webhooks.provider.github"]) {
    expect(keys.has(key), key).toBe(true);
  }
  for (const key of Object.keys(planData().plans.free!.manifest_limits)) expect(keys.has(key), key).toBe(true);
  expect(keys.has("release.bundle_bytes.max")).toBe(true);
  // Free already includes these, and account features are not manifest features.
  for (const key of ["runtime.server", "data.enabled", "secrets.enabled", "custom_domains", "app_analytics", "priority_support"]) {
    expect(keys.has(key), key).toBe(false);
  }
});

it("puts a static or simple server app on Free", () => {
  expect(computePlanMetadata(manifest())).toEqual({ required_plan: "free", paid_features: [] });
  expect(computePlanMetadata(manifest({ auth: { mode: "app_users", roles: ["admin"] }, secrets: { required: ["ONE"] } }))).toEqual({ required_plan: "free", paid_features: [] });
});

it("finds the lowest plan for features and limits", () => {
  expect(computePlanMetadata(manifest({ secrets: { required: ["ONE", "TWO"] } }))).toEqual({ required_plan: "starter", paid_features: ["secrets.required.max"] });
  expect(computePlanMetadata(manifest({ jobs: { tidy: { trigger: "schedule", schedule: "daily" } } }))).toEqual({
    required_plan: "starter",
    paid_features: ["jobs.scheduled", "jobs.schedule.allowed"]
  });
  expect(computePlanMetadata(manifest({ jobs: { tidy: { trigger: "schedule", schedule: "hourly" } } })).required_plan).toBe("business");
  expect(computePlanMetadata(manifest({ auth: { mode: "app_users", public_signup: true } })).required_plan).toBe("business");
  expect(computePlanMetadata(manifest({}, { app: { name: "Private", visibility: "private" } })).required_plan).toBe("business");
  expect(computePlanMetadata(manifest({ data: { collections: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`c${index}`, { fields: {} }])) } })).required_plan).toBe("business");
  expect(computePlanMetadata(manifest({ auth: { mode: "app_users", roles: Array.from({ length: 21 }, (_, index) => `r${index}`) } })).required_plan).toBe("business_plus");
});

it("never names a plan that is not on sale", () => {
  // More than Business Plus allows: the CLI reports its support-only key, which the catalog rejects.
  const beyond = computePlanMetadata(manifest({ auth: { mode: "app_users", roles: Array.from({ length: 51 }, (_, index) => `r${index}`) } }));
  expect(beyond.required_plan).toBe("internal");
  expect(allowedPlans.has(beyond.required_plan)).toBe(false);
});

it("counts release size and file count when given", () => {
  const free = planData().plans.free!.release_limits;
  const release = { file_count: (free["release.file_count.max"] as number) + 1, bundle_bytes: 1 };
  expect(computePlanMetadata(manifest(), release)).toEqual({ required_plan: "starter", paid_features: ["release.file_count.max"] });
});

it("matches `userland validate` and the catalog metadata for every example", async () => {
  const examples = readdirSync(path.join(root, "examples"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  expect(examples.length).toBeGreaterThan(0);
  for (const example of examples) {
    const dir = path.join(root, "examples", example.name);
    if (!existsSync(path.join(dir, "example.json"))) continue;
    const meta = JSON.parse(readFileSync(path.join(dir, "example.json"), "utf8")) as { required_plan: string; paid_features: string[] };
    const report = await validateAppDirectory(dir, { strict: true });
    expect({ slug: example.name, errors: report.errors }).toEqual({ slug: example.name, errors: [] });
    const fromCli = planMetadataFromReport(report);
    const fromManifest = computePlanMetadata(JSON.parse(readFileSync(path.join(dir, "manifest.userland.json"), "utf8")) as Record<string, unknown>);
    expect({ slug: example.name, ...fromManifest }).toEqual({ slug: example.name, ...fromCli });
    expect({ slug: example.name, required_plan: meta.required_plan, paid_features: [...meta.paid_features].sort() }).toEqual({
      slug: example.name,
      required_plan: fromCli.required_plan,
      paid_features: [...fromCli.paid_features].sort()
    });
  }
});

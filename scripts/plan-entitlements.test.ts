import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { computePlanMetadata, MANIFEST_FEATURE_KEYS, MANIFEST_LIMIT_KEYS, PLAN_ORDER, PLAN_RULES } from "./plan-entitlements.js";

const root = path.resolve(import.meta.dirname, "..");

function manifest(resources: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { app: { name: "Test", visibility: "public" }, runtime: { static_root: "public", server_entry: "server/index.js" }, resources, ...extra };
}

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
});

it("matches the plan metadata of every example that has a manifest", () => {
  const examples = readdirSync(path.join(root, "examples"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const example of examples) {
    const dir = path.join(root, "examples", example.name);
    if (!existsSync(path.join(dir, "manifest.userland.json")) || !existsSync(path.join(dir, "example.json"))) continue;
    const meta = JSON.parse(readFileSync(path.join(dir, "example.json"), "utf8")) as { required_plan?: string; paid_features?: string[] };
    if (meta.required_plan === undefined) continue;
    const computed = computePlanMetadata(JSON.parse(readFileSync(path.join(dir, "manifest.userland.json"), "utf8")));
    expect({ slug: example.name, required_plan: meta.required_plan, paid_features: [...(meta.paid_features ?? [])].sort() }).toEqual({
      slug: example.name,
      required_plan: computed.required_plan,
      paid_features: [...computed.paid_features].sort()
    });
  }
});

// Guards the snapshot against drift from the platform's plan rules. Runs only
// when USERLAND_REPO_DIR points at a checkout of the platform repo.
const platformDir = process.env.USERLAND_REPO_DIR;
const platformEntitlements = platformDir ? path.join(platformDir, "packages/shared/src/entitlements.ts") : "";
it.skipIf(!platformDir || !existsSync(platformEntitlements))("matches the platform plan rules", async () => {
  const platform = (await import(platformEntitlements)) as {
    PLAN_ORDER: string[];
    PLAN_CONFIG: Record<string, { features: Record<string, boolean>; manifest_limits: Record<string, unknown> }>;
  };
  expect(platform.PLAN_ORDER).toEqual([...PLAN_ORDER]);
  for (const plan of PLAN_ORDER) {
    for (const key of MANIFEST_FEATURE_KEYS) expect({ plan, key, value: PLAN_RULES[plan].features[key] }).toEqual({ plan, key, value: platform.PLAN_CONFIG[plan]!.features[key] });
    for (const key of MANIFEST_LIMIT_KEYS) expect({ plan, key, value: PLAN_RULES[plan].manifest_limits[key] }).toEqual({ plan, key, value: platform.PLAN_CONFIG[plan]!.manifest_limits[key] });
    expect(Object.keys(platform.PLAN_CONFIG[plan]!.manifest_limits).sort()).toEqual([...MANIFEST_LIMIT_KEYS].sort());
  }
});

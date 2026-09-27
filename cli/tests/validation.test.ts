import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  analyzeAppDirectory,
  analyzeManifestRequirements,
  applyPlan,
  checkManifestDocument,
  evaluateRequirements,
  manifestSchema,
  minimumPlanFor,
  normalizePlanKey,
  isSelfServePlan,
  planData,
  planDisplayName,
  planRequirementText,
  releasePathError,
  releaseRequirements,
  SUPPORT_ONLY_PLAN_KEY,
  SUPPORTED_SCHEMA_KEYWORDS,
  validateAppDirectory,
  validateManifestDocument,
  type ManifestInput
} from "../src/validation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirs: string[] = [];

interface ParityCase {
  name: string;
  manifest: ManifestInput;
  required_plan_key: string;
  violations_by_plan: Record<string, Record<string, string>>;
}

const parity = JSON.parse(await fs.readFile(path.join(repoRoot, "cli", "tests", "fixtures", "plan-parity.json"), "utf8")) as { cases: ParityCase[] };

function base(): ManifestInput {
  return { app: { name: "Case", visibility: "public" }, runtime: { static_root: "public" }, resources: {} };
}

function violationsFor(manifest: ManifestInput, plan: string): Record<string, string> {
  const findings = evaluateRequirements(analyzeManifestRequirements(manifest), plan, planData().plans[plan]);
  const byKey: Record<string, string> = {};
  for (const finding of findings) {
    const key = (finding.feature_key ?? finding.limit_key) as string;
    byKey[key] = key in byKey ? higherPlan(byKey[key], finding.required_plan_key) : finding.required_plan_key;
  }
  return byKey;
}

function higherPlan(left: string, right: string): string {
  const order = [...planData().plan_order, SUPPORT_ONLY_PLAN_KEY];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

async function appDir(manifest: unknown, files: Record<string, string> = { "public/index.html": "<h1>hi</h1>" }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "userland-validate-"));
  tempDirs.push(dir);
  if (manifest !== undefined) {
    await fs.writeFile(path.join(dir, "manifest.userland.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
  }
  for (const [filePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, filePath)), { recursive: true });
    await fs.writeFile(path.join(dir, filePath), contents);
  }
  return dir;
}

describe("plan artifact", () => {
  test("lists only the self-serve plans in order: no retired Agency plan, no internal plan", () => {
    const data = planData();
    expect(data.plan_order).toEqual(["free", "starter", "business", "business_plus"]);
    expect(Object.keys(data.plans)).toEqual(data.plan_order);
    expect(data.plans).not.toHaveProperty("internal");
    expect(data.plans).not.toHaveProperty("agency");
    expect(JSON.stringify(data)).not.toMatch(/agency/iu);
    for (const plan of data.plan_order) {
      expect(Object.keys(data.plans[plan].manifest_limits).sort()).toEqual(Object.keys(data.plans.free.manifest_limits).sort());
      expect(Object.keys(data.plans[plan].features).sort()).toEqual(Object.keys(data.plans.free.features).sort());
    }
  });

  test("normalizes plan names and aliases", () => {
    expect(normalizePlanKey("free")).toBe("free");
    expect(normalizePlanKey("Business_Plus")).toBe("business_plus");
    expect(normalizePlanKey("pro")).toBe("starter");
    expect(normalizePlanKey("team")).toBe("business");
    expect(normalizePlanKey("internal")).toBeUndefined();
    expect(normalizePlanKey("agency")).toBeUndefined();
    expect(normalizePlanKey("Agency")).toBeUndefined();
    expect(normalizePlanKey("gold")).toBeUndefined();
  });

  test("plan requirement text never offers a plan that is not on sale", () => {
    expect(planRequirementText("business")).toBe("requires Business");
    expect(planRequirementText("business_plus")).toBe("requires Business Plus");
    expect(planRequirementText(SUPPORT_ONLY_PLAN_KEY)).toBe("is not available on self-serve plans; contact support");
    expect(planRequirementText("agency")).toBe("is not available on self-serve plans; contact support");
    expect(isSelfServePlan("agency")).toBe(false);
    expect(isSelfServePlan(SUPPORT_ONLY_PLAN_KEY)).toBe(false);
    // An account still on a retired plan gets a readable name for its current plan.
    expect(planDisplayName("agency")).toBe("Agency");
  });
});

describe("plan parity with the API plan rules", () => {
  test.each(parity.cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const requirements = analyzeManifestRequirements(entry.manifest);
    expect(minimumPlanFor(requirements)).toBe(entry.required_plan_key);
    for (const plan of planData().plan_order) {
      expect(violationsFor(entry.manifest, plan)).toEqual(entry.violations_by_plan[plan]);
    }
  });

  test("covers every public plan and the issue #2 feature matrix", () => {
    const names = parity.cases.map((entry) => entry.name);
    for (const required of ["private-app", "public-signup", "scheduled-daily", "scheduled-hourly", "scheduled-every_15_minutes", "webhook-generic_hmac", "webhook-github", "private-store", "secrets-2", "collections-3", "roles-3", "stores-2", "indexes-3"]) {
      expect(names).toContain(required);
    }
    expect(new Set(parity.cases.map((entry) => entry.required_plan_key))).toEqual(new Set(["free", "starter", "business", "business_plus", SUPPORT_ONLY_PLAN_KEY]));
  });
});

describe("offline entitlement checks", () => {
  const cases: Array<{ name: string; mutate: (manifest: ManifestInput) => void; key: string; path: string; free: boolean; starter: boolean; business: boolean }> = [
    { name: "private apps", mutate: (m) => (m.app.visibility = "private"), key: "private_apps", path: "app.visibility", free: false, starter: false, business: true },
    { name: "public signup", mutate: (m) => (m.resources.auth = { mode: "app_users", public_signup: true }), key: "auth.public_signup", path: "resources.auth.public_signup", free: false, starter: false, business: true },
    { name: "daily scheduled job", mutate: (m) => (m.resources.jobs = { nightly: { trigger: "schedule", schedule: "daily" } }), key: "jobs.scheduled", path: "resources.jobs.nightly.trigger", free: false, starter: true, business: true },
    { name: "hourly scheduled job", mutate: (m) => (m.resources.jobs = { sweep: { trigger: "schedule", schedule: "hourly" } }), key: "jobs.schedule.allowed", path: "resources.jobs.sweep.schedule", free: false, starter: false, business: true },
    { name: "generic HMAC webhook", mutate: (m) => (m.resources.webhooks = { hook: { provider: "generic_hmac", secret: "HOOK_SECRET", deliver_to: "server" } }), key: "webhooks.provider.generic_hmac", path: "resources.webhooks.hook.provider", free: false, starter: true, business: true },
    { name: "GitHub webhook", mutate: (m) => (m.resources.webhooks = { gh: { provider: "github", secret: "GH_SECRET", deliver_to: "server" } }), key: "webhooks.provider.github", path: "resources.webhooks.gh.provider", free: false, starter: false, business: true },
    { name: "private file store", mutate: (m) => (m.resources.files = { stores: { vault: { public: false } } }), key: "files.private_stores", path: "resources.files.stores.vault.public", free: false, starter: false, business: true },
    { name: "file store count", mutate: (m) => (m.resources.files = { stores: { a: {}, b: {} } }), key: "files.stores.max", path: "resources.files.stores", free: false, starter: true, business: true },
    { name: "file upload size", mutate: (m) => (m.resources.files = { stores: { media: { max_file_size_bytes: 30 * 1024 * 1024 } } }), key: "files.max_upload_size_bytes.max", path: "resources.files.stores.media.max_file_size_bytes", free: false, starter: false, business: true },
    { name: "required secrets", mutate: (m) => (m.resources.secrets = { required: ["A_KEY", "B_KEY"] }), key: "secrets.required.max", path: "resources.secrets.required", free: false, starter: true, business: true },
    { name: "data collections", mutate: (m) => (m.resources.data = { collections: { a: {}, b: {}, c: {} } }), key: "data.collections.max", path: "resources.data.collections", free: false, starter: true, business: true },
    { name: "indexes per collection", mutate: (m) => (m.resources.data = { collections: { posts: { fields: { a: "string" }, indexes: ["i1", "i2", "i3"].map((name) => ({ name, fields: ["a"] })) } } }), key: "data.indexes_per_collection.max", path: "resources.data.collections.posts.indexes", free: false, starter: true, business: true },
    { name: "app-user roles", mutate: (m) => (m.resources.auth = { mode: "app_users", roles: ["a", "b", "c"] }), key: "auth.roles.max", path: "resources.auth.roles", free: false, starter: true, business: true },
    { name: "declared jobs", mutate: (m) => (m.resources.jobs = { a: {}, b: {} }), key: "jobs.declared.max", path: "resources.jobs", free: false, starter: true, business: true }
  ];

  test.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const manifest = base();
    entry.mutate(manifest);
    expect(validateManifestDocument(manifest as unknown as Record<string, unknown>)).toEqual([]);
    for (const plan of ["free", "starter", "business"] as const) {
      const findings = evaluateRequirements(analyzeManifestRequirements(manifest), plan, planData().plans[plan]);
      const finding = findings.find((candidate) => (candidate.feature_key ?? candidate.limit_key) === entry.key);
      if (entry[plan]) {
        expect(finding, `${entry.key} should be allowed on ${plan}`).toBeUndefined();
      } else {
        expect(finding, `${entry.key} should be blocked on ${plan}`).toMatchObject({ manifest_path: entry.path, plan_key: plan });
        expect(finding?.required_plan_key).not.toBe(plan);
      }
    }
  });

  test("email verification is not offered on any self-serve plan", () => {
    const manifest = base();
    manifest.resources.auth = { mode: "app_users", email_verification: true };
    const requirements = analyzeManifestRequirements(manifest);
    expect(minimumPlanFor(requirements)).toBe(SUPPORT_ONLY_PLAN_KEY);
    const [finding] = evaluateRequirements(requirements, "business_plus", planData().plans.business_plus);
    expect(finding).toMatchObject({
      feature_key: "auth.email_verification",
      required_plan_key: SUPPORT_ONLY_PLAN_KEY,
      allowed: false,
      message: "App-user email verification: is not available on self-serve plans; contact support."
    });
  });

  test("limits beyond Business Plus point to support, not to a retired or internal plan", () => {
    const manifest = base();
    manifest.resources.auth = { mode: "app_users", roles: Array.from({ length: 51 }, (_, index) => `role${index}`) };
    const requirements = analyzeManifestRequirements(manifest);
    expect(minimumPlanFor(requirements)).toBe(SUPPORT_ONLY_PLAN_KEY);
    const findings = evaluateRequirements(requirements, "business_plus", planData().plans.business_plus);
    expect(findings).toEqual([expect.objectContaining({ limit_key: "auth.roles.max", required_plan_key: SUPPORT_ONLY_PLAN_KEY })]);
    expect(findings[0].message).toBe("App-user roles: 51 exceeds the Business Plus limit of 50. This value is not available on self-serve plans; contact support.");
    // An account on a retired plan is checked against its own entitlements and named plainly.
    const [retired] = evaluateRequirements(requirements, "agency", planData().plans.business_plus);
    expect(retired.message).toContain("exceeds the Agency limit of 50");
    expect(retired.message).not.toMatch(/requires (Agency|Internal)/iu);
  });

  test("release file count and size limits are plan-gated", () => {
    const free = planData().plans.free.release_limits;
    const findings = evaluateRequirements(releaseRequirements((free["release.file_count.max"] as number) + 1, (free["release.bundle_bytes.max"] as number) + 1), "free", planData().plans.free);
    expect(findings.map((finding) => [finding.kind, finding.limit_key, finding.required_plan_key])).toEqual([
      ["release_limit", "release.file_count.max", "starter"],
      ["release_limit", "release.bundle_bytes.max", "starter"]
    ]);
  });

  test("account entitlements override the plan table", () => {
    const manifest = base();
    manifest.app.visibility = "private";
    const requirements = analyzeManifestRequirements(manifest);
    const comped = { ...planData().plans.free, features: { ...planData().plans.free.features, private_apps: true } };
    expect(evaluateRequirements(requirements, "free", comped)).toEqual([]);
    expect(evaluateRequirements(requirements, "free", planData().plans.free)).toHaveLength(1);
  });
});

describe("manifest schema validation", () => {
  test("the validator supports every keyword the published schema uses", () => {
    const used = new Set<string>();
    const visit = (node: unknown, inPropertiesMap = false): void => {
      if (Array.isArray(node)) return node.forEach((child) => visit(child));
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (!inPropertiesMap) used.add(key);
        visit(value, !inPropertiesMap && (key === "properties" || key === "$defs"));
      }
    };
    visit(manifestSchema());
    expect([...used].filter((keyword) => !SUPPORTED_SCHEMA_KEYWORDS.has(keyword))).toEqual([]);
  });

  test("reports shape errors with manifest paths", () => {
    const errors = validateManifestDocument({
      app: { name: "Bad", visibility: "secret", tags: ["secrets"] },
      runtime: { static_root: "public", fallback: "spa" },
      resources: {
        auth: { mode: "everyone" },
        data: { collections: { Posts: {}, notes: { fields: { id: "string" } } } },
        files: { stores: { media: { max_file_size_bytes: 0, allowed_content_types: ["image"] } } },
        secrets: { required: ["USERLAND_TOKEN"] },
        jobs: { nightly: { trigger: "schedule", schedule: "weekly" }, cleanup: { trigger: "schedule" } },
        webhooks: { gh: { provider: "github", deliver_to: "server" } }
      }
    });
    const byPath = Object.fromEntries(errors.map((error) => [error.manifest_path, error.message]));
    expect(byPath).toMatchObject({
      "app.visibility": "must be one of: public, private",
      "app.tags[0]": '"secrets" is reserved',
      "runtime.fallback": "must be one of: server, index.html, 404",
      "resources.auth.mode": "must be one of: none, app_users",
      "resources.data.collections.Posts": expect.stringContaining("lowercase letters"),
      "resources.data.collections.notes.fields.id": expect.stringContaining("reserved"),
      "resources.files.stores.media.max_file_size_bytes": "must be at least 1",
      "resources.files.stores.media.allowed_content_types[0]": expect.stringContaining("image"),
      "resources.secrets.required[0]": expect.stringContaining("USERLAND_"),
      "resources.jobs.nightly.schedule": "must be one of: every_15_minutes, hourly, daily",
      "resources.jobs.cleanup.schedule": "is required",
      "resources.webhooks.gh.secret": "is required"
    });
  });

  test("separates schema-only strictness the API tolerates from API errors", () => {
    const tolerated: Array<[string, Record<string, unknown>, string[]]> = [
      ["unknown app, runtime, and resources keys", { app: { name: "x", description: "d" }, runtime: { static_root: "public", headers: {} }, resources: { queues: {} } }, ["app.description", "runtime.headers", "resources.queues"]],
      ["unknown top-level key", { app: { name: "x" }, runtime: { static_root: "public" }, extra: true }, ["extra"]],
      ["resources null", { app: { name: "x" }, runtime: { static_root: "public" }, resources: null }, ["resources"]],
      ["null defaults", { app: { name: "x" }, runtime: { static_root: "public" }, resources: { auth: { mode: null }, jobs: { a: { trigger: null, max_attempts: null } } } }, ["resources.auth.mode", "resources.jobs.a.trigger", "resources.jobs.a.max_attempts"]],
      ["whitespace the API trims", {
        app: { name: "x", tags: [" cms"] },
        runtime: { static_root: "public" },
        resources: {
          secrets: { required: [" API_KEY"] },
          files: { stores: { media: { allowed_content_types: [" text/html"] } } },
          webhooks: { gh: { provider: "github", deliver_to: "server", secret: "GH_SECRET " } }
        }
      }, ["app.tags[0]", "resources.secrets.required[0]", "resources.files.stores.media.allowed_content_types[0]", "resources.webhooks.gh.secret"]],
      ["schema-only data rules", {
        app: { name: "x" },
        runtime: { static_root: "public" },
        resources: { data: { collections: { posts: { fields: { title: "string", state: { type: "enum", values: ["", "done"] } }, indexes: [{ name: "id", fields: ["title"] }, { name: "created_at", fields: ["title"] }] } } } }
      }, ["resources.data.collections.posts.indexes[0].name", "resources.data.collections.posts.indexes[1].name", "resources.data.collections.posts.fields.state.values[0]"]]
    ];
    for (const [name, document, paths] of tolerated) {
      const check = checkManifestDocument(document);
      expect(check.errors, name).toEqual([]);
      expect(check.schema_strict.map((issue) => issue.manifest_path).sort(), name).toEqual([...paths].sort());
      expect(check.schema_strict.every((issue) => issue.code === "schema_strict" && issue.message.includes("the API accepts it today")), name).toBe(true);
    }

    // Unknown keys deeper in resources are API errors, and real errors still block alongside tolerated ones.
    const mixed = checkManifestDocument({
      app: { name: "x", description: "d", visibility: "secret" },
      runtime: { static_root: "public" },
      resources: { auth: { extra: true }, data: { collections: { posts: { extra: 1 } } } }
    });
    expect(mixed.errors.map((error) => error.manifest_path)).toEqual(["app.visibility", "resources.auth.extra", "resources.data.collections.posts.extra"]);
    expect(mixed.schema_strict.map((issue) => issue.manifest_path)).toEqual(["app.description"]);
  });

  test("requires a webhook secret for signed providers on every delivery target", () => {
    const jobs = { sync: {} };
    const paths = (webhook: Record<string, unknown>) =>
      validateManifestDocument({ app: { name: "x" }, runtime: { static_root: "public" }, resources: { jobs, webhooks: { hook: webhook } } }).map((error) => `${error.manifest_path}: ${error.message}`);
    expect(paths({ provider: "github", deliver_to: "job:sync" })).toEqual(["resources.webhooks.hook.secret: is required when provider is github"]);
    expect(paths({ provider: "generic_hmac", deliver_to: "job", job: "sync" })).toEqual(["resources.webhooks.hook.secret: is required when provider is generic_hmac"]);
    expect(paths({ provider: "github", deliver_to: "job:sync", secret: "GH_SECRET" })).toEqual([]);
    expect(paths({ provider: "none", deliver_to: "job:sync" })).toEqual([]);
  });

  test("enforces the cross-field rules the API checks", () => {
    const errors = validateManifestDocument({
      app: { name: "   " },
      runtime: { static_root: "public/" },
      resources: {
        data: {
          collections: {
            posts: {
              fields: { title: "string" },
              indexes: [{ name: "by_x", fields: ["missing"] }, { name: "by_x", fields: ["title"] }],
              access: { write: "role:system" }
            }
          }
        },
        files: { stores: { media: { allowed_content_types: ["image/png", "IMAGE/PNG"] } } },
        webhooks: { hook: { provider: "none", deliver_to: "job:missing" } }
      }
    });
    expect(errors.map((error) => error.manifest_path).sort()).toEqual([
      "app.name",
      "resources.data.collections.posts.access.write",
      "resources.data.collections.posts.indexes[0].fields[0]",
      "resources.data.collections.posts.indexes[1].name",
      "resources.files.stores.media.allowed_content_types",
      "resources.webhooks.hook.deliver_to",
      "runtime.static_root"
    ]);
  });

  test("rejects unsafe release paths", () => {
    expect(releasePathError("public/index.html")).toBeUndefined();
    expect(releasePathError("/etc/passwd")).toContain("absolute");
    // The API accepts drive-letter-looking names; on Userland they are ordinary relative paths.
    expect(releasePathError("C:/app")).toBeUndefined();
    expect(releasePathError("public/../secret")).toContain("..");
    expect(releasePathError("public\\index.html")).toContain("backslashes");
    expect(releasePathError("_userland/state.json")).toContain("_userland");
    expect(releasePathError("public//index.html")).toContain("empty");
    expect(releasePathError("./public")).toContain("empty or .");
  });
});

describe("validateAppDirectory", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test("checks referenced files, runtime paths, and walked release files", async () => {
    const dir = await appDir(
      {
        app: { name: "Paths" },
        runtime: { static_root: "public", server_entry: "server/index.js", fallback: "server" },
        resources: {},
        files: [{ path: "public/index.html" }, { path: "/etc/passwd" }, { path: "../outside.txt" }, { path: "public/missing.html" }, { path: "_userland/x.txt" }, { path: "public\\win.txt" }]
      }
    );
    const report = await validateAppDirectory(dir);
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => [error.code, error.manifest_path])).toEqual([
      ["unsafe_path", "files[1].path"],
      ["unsafe_path", "files[2].path"],
      ["missing_file", "files[3].path"],
      ["unsafe_path", "files[4].path"],
      ["unsafe_path", "files[5].path"],
      ["missing_server_entry", "runtime.server_entry"]
    ]);
  });

  test("rejects reserved and backslash paths in walked directories", async () => {
    const dir = await appDir({ app: { name: "Walk" }, runtime: { static_root: "public" } }, {
      "public/index.html": "ok",
      "_userland/state.json": "{}",
      "public/a\\b.txt": "x"
    });
    const report = await validateAppDirectory(dir);
    expect(report.errors.map((error) => [error.code, error.file])).toEqual([
      ["unsafe_path", "_userland/state.json"],
      ["unsafe_path", "public/a\\b.txt"]
    ]);
  });

  test("requires static_root to contain a release file", async () => {
    const missing = await validateAppDirectory(await appDir({ app: { name: "Missing root" }, runtime: { static_root: "site" } }));
    expect(missing.errors).toEqual([{ code: "missing_file", manifest_path: "runtime.static_root", message: "site does not exist" }]);

    const emptyDir = await appDir({ app: { name: "Empty root" }, runtime: { static_root: "site" } });
    await fs.mkdir(path.join(emptyDir, "site"));
    const empty = await validateAppDirectory(emptyDir);
    expect(empty.errors).toEqual([{ code: "missing_static_root", manifest_path: "runtime.static_root", message: "site must contain at least one release file" }]);
  });

  test("reports invalid JSON and falls back to CLI defaults without a manifest", async () => {
    const broken = await validateAppDirectory(await appDir("{ not json"));
    expect(broken.errors[0]).toMatchObject({ code: "invalid_json" });

    const implicit = await validateAppDirectory(await appDir(undefined));
    expect(implicit.ok).toBe(true);
    expect(implicit.warnings.map((warning) => warning.code)).toEqual(["missing_manifest"]);
    expect(implicit.required_plan_key).toBe("free");
  });

  test("tolerates CLI-only keys and $schema, and warns about unknown top-level keys", async () => {
    const manifest = {
      $schema: "https://docs.userland.fun/schemas/resource-manifest-v0.schema.json",
      app: { name: "Keys" },
      runtime: { static_root: "public" },
      message: "hello",
      provenance: { source: "test" },
      extra: true
    };
    const report = await validateAppDirectory(await appDir(manifest));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      expect.objectContaining({ code: "schema_strict", manifest_path: "extra", message: expect.stringMatching(/is not an allowed key \(allowed: .*app, runtime, resources/u) })
    ]);

    const strict = await validateAppDirectory(await appDir(manifest), { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.errors.map((error) => [error.code, error.manifest_path])).toEqual([["schema_strict", "extra"]]);
    expect(strict.required_plan_key).toBe("free");

    const badSchemaKey = await validateAppDirectory(await appDir({ ...manifest, $schema: 1, extra: undefined }));
    expect(badSchemaKey.errors).toEqual([{ code: "schema", manifest_path: "$schema", message: "must be a string" }]);
  });

  test("warns when listed files resolve outside the app directory and when symlinks are skipped", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "userland-outside-"));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");

    const listed = await appDir({ app: { name: "Links" }, runtime: { static_root: "public" }, files: [{ path: "public/index.html" }, { path: "public/leak.txt" }] });
    await fs.symlink(path.join(outside, "secret.txt"), path.join(listed, "public", "leak.txt"));
    const listedReport = await validateAppDirectory(listed);
    expect(listedReport.ok).toBe(true);
    expect(listedReport.release.file_count).toBe(2);
    expect(listedReport.warnings).toEqual([
      expect.objectContaining({ code: "outside_app_directory", manifest_path: "files[1].path", file: "public/leak.txt", message: expect.stringContaining("resolves outside the app directory") })
    ]);

    const inside = await appDir({ app: { name: "Links" }, runtime: { static_root: "public" }, files: [{ path: "public/index.html" }, { path: "public/alias.html" }] });
    await fs.symlink("index.html", path.join(inside, "public", "alias.html"));
    expect((await validateAppDirectory(inside)).warnings).toEqual([]);

    const walked = await appDir({ app: { name: "Links" }, runtime: { static_root: "public" } });
    await fs.symlink(path.join(outside, "secret.txt"), path.join(walked, "public", "leak.txt"));
    const walkedReport = await validateAppDirectory(walked);
    expect(walkedReport.release.file_count).toBe(1);
    expect(walkedReport.warnings).toEqual([
      expect.objectContaining({ code: "symlinks_skipped", message: expect.stringContaining("1 symlink is not uploaded (public/leak.txt)") })
    ]);
  });

  test("applies plans to one analysis without re-reading the directory", async () => {
    const dir = await appDir({ app: { name: "Plan", visibility: "private" }, runtime: { static_root: "public" } });
    const analysis = await analyzeAppDirectory(dir);
    expect(analysis.report.plan).toBeNull();
    expect(analysis.requirements).not.toBeNull();
    await fs.rm(dir, { recursive: true, force: true });

    const free = applyPlan(analysis, { planKey: "free", planSource: "account" });
    expect(free.ok).toBe(false);
    expect(free.plan_source).toBe("account");
    expect(free.violations.map((finding) => finding.feature_key)).toEqual(["private_apps"]);
    const business = applyPlan(analysis, { planKey: "business" });
    expect(business.ok).toBe(true);
    expect(business.plan_source).toBe("flag");
    expect(analysis.report.violations).toEqual([]);
  });

  test("gates releases above the plan file count", async () => {
    const limit = planData().plans.free.release_limits["release.file_count.max"] as number;
    const files: Record<string, string> = {};
    for (let index = 0; index <= limit; index += 1) files[`public/f${index}.txt`] = "x";
    const dir = await appDir({ app: { name: "Many" }, runtime: { static_root: "public" } }, files);
    const report = await validateAppDirectory(dir, { planKey: "free" });
    expect(report.release.file_count).toBe(limit + 1);
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "release_limit", limit_key: "release.file_count.max", value: limit + 1, allowed: limit, required_plan_key: "starter" })
    ]);
    expect(report.required_plan_key).toBe("starter");
  });
});

describe("public examples", () => {
  test("every example validates cleanly and declares any paid plan it needs", async () => {
    const examplesRoot = path.join(repoRoot, "examples");
    const entries = (await fs.readdir(examplesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const dir = path.join(examplesRoot, entry.name);
      const report = await validateAppDirectory(dir);
      expect(report.errors, `${entry.name} should have no validation errors`).toEqual([]);
      const required = report.required_plan_key as string;
      expect(isSelfServePlan(required), `${entry.name} should fit a self-serve plan (got ${required})`).toBe(true);

      const planReport = await validateAppDirectory(dir, { planKey: required });
      expect(planReport.ok, `${entry.name} should pass on ${required}`).toBe(true);

      const metadata = JSON.parse(await fs.readFile(path.join(dir, "example.json"), "utf8")) as { required_plan?: string };
      if (metadata.required_plan !== undefined) {
        expect(metadata.required_plan, `${entry.name} example.json required_plan`).toBe(required);
      } else if (required !== "free") {
        const readme = await fs.readFile(path.join(dir, "README.md"), "utf8");
        expect(readme, `${entry.name} README should state its plan requirement`).toContain(`requires a ${planData().plans[required].display_name} account plan`);
      }
    }
  });
});

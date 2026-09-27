import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  analyzeManifestRequirements,
  evaluateRequirements,
  manifestSchema,
  minimumPlanFor,
  normalizePlanKey,
  planData,
  releasePathError,
  releaseRequirements,
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
  required_plan_key: string | null;
  violations_by_plan: Record<string, Record<string, string | null>>;
}

const parity = JSON.parse(await fs.readFile(path.join(repoRoot, "cli", "tests", "fixtures", "plan-parity.json"), "utf8")) as { cases: ParityCase[] };

function base(): ManifestInput {
  return { app: { name: "Case", visibility: "public" }, runtime: { static_root: "public" }, resources: {} };
}

function violationsFor(manifest: ManifestInput, plan: string): Record<string, string | null> {
  const findings = evaluateRequirements(analyzeManifestRequirements(manifest), plan, planData().plans[plan]);
  const byKey: Record<string, string | null> = {};
  for (const finding of findings) {
    const key = (finding.feature_key ?? finding.limit_key) as string;
    byKey[key] = key in byKey ? higherPlan(byKey[key], finding.required_plan_key) : finding.required_plan_key;
  }
  return byKey;
}

function higherPlan(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  const order = planData().plan_order;
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
  test("lists the public launch plans in order and hides internal", () => {
    const data = planData();
    expect(data.plan_order).toEqual(["free", "starter", "business", "business_plus", "agency"]);
    expect(Object.keys(data.plans)).toEqual(data.plan_order);
    expect(data.plans).not.toHaveProperty("internal");
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
    expect(normalizePlanKey("gold")).toBeUndefined();
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
    expect(new Set(parity.cases.map((entry) => entry.required_plan_key))).toEqual(new Set(["free", "starter", "business", "business_plus", null]));
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

  test("email verification is not offered on any public plan", () => {
    const manifest = base();
    manifest.resources.auth = { mode: "app_users", email_verification: true };
    const requirements = analyzeManifestRequirements(manifest);
    expect(minimumPlanFor(requirements)).toBeNull();
    const [finding] = evaluateRequirements(requirements, "agency", planData().plans.agency);
    expect(finding).toMatchObject({ feature_key: "auth.email_verification", required_plan_key: null, allowed: false });
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
        webhooks: { gh: { provider: "github", deliver_to: "server" } },
        queues: {}
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
      "resources.webhooks.gh.secret": "is required",
      "resources.queues": expect.stringContaining("is not an allowed key")
    });
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
    expect(releasePathError("C:/app")).toContain("absolute");
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

  test("tolerates CLI-only keys and flags unknown top-level keys", async () => {
    const dir = await appDir({ app: { name: "Keys" }, runtime: { static_root: "public" }, message: "hello", provenance: { source: "test" }, extra: true });
    const report = await validateAppDirectory(dir);
    expect(report.errors).toEqual([{ code: "schema", manifest_path: "extra", message: "is not an allowed key (allowed: app, runtime, resources)" }]);
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
      expect(report.required_plan_key, `${entry.name} should fit a public plan`).not.toBeNull();
      const required = report.required_plan_key as string;

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

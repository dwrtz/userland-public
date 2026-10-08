import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  analyzeAppDirectory,
  analyzeManifestRequirements,
  applyPlan,
  checkEmbedOrigin,
  checkManifestDocument,
  EMBED_ORIGINS_MAX_COUNT,
  embedOriginList,
  evaluateRequirements,
  findManifest,
  formatWarning,
  listReleaseFiles,
  manifestSchema,
  minimumPlanFor,
  normalizePlanKey,
  isSelfServePlan,
  planData,
  planDisplayName,
  planRequirementText,
  PRIVATE_APPS_REFUSED,
  releaseFileProblem,
  releasePathError,
  releaseRequirements,
  SUPPORT_ONLY_PLAN_KEY,
  SUPPORTED_SCHEMA_KEYWORDS,
  validateAgainstSchema,
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
    for (const required of ["public-signup", "scheduled-daily", "scheduled-hourly", "scheduled-every_15_minutes", "webhook-generic_hmac", "webhook-github", "webhook-stripe", "private-store", "secrets-2", "collections-3", "roles-3", "stores-2", "indexes-3"]) {
      expect(names).toContain(required);
    }
    expect(new Set(parity.cases.map((entry) => entry.required_plan_key))).toEqual(new Set(["free", "starter", "business", "business_plus", SUPPORT_ONLY_PLAN_KEY]));
  });
});

describe("offline entitlement checks", () => {
  const cases: Array<{ name: string; mutate: (manifest: ManifestInput) => void; key: string; path: string; free: boolean; starter: boolean; business: boolean }> = [
    { name: "public signup", mutate: (m) => (m.resources.auth = { mode: "app_users", public_signup: true }), key: "auth.public_signup", path: "resources.auth.public_signup", free: false, starter: false, business: true },
    { name: "daily scheduled job", mutate: (m) => (m.resources.jobs = { nightly: { trigger: "schedule", schedule: "daily" } }), key: "jobs.scheduled", path: "resources.jobs.nightly.trigger", free: false, starter: true, business: true },
    { name: "hourly scheduled job", mutate: (m) => (m.resources.jobs = { sweep: { trigger: "schedule", schedule: "hourly" } }), key: "jobs.schedule.allowed", path: "resources.jobs.sweep.schedule", free: false, starter: false, business: true },
    { name: "generic HMAC webhook", mutate: (m) => (m.resources.webhooks = { hook: { provider: "generic_hmac", secret: "HOOK_SECRET", deliver_to: "server" } }), key: "webhooks.provider.generic_hmac", path: "resources.webhooks.hook.provider", free: false, starter: true, business: true },
    { name: "GitHub webhook", mutate: (m) => (m.resources.webhooks = { gh: { provider: "github", secret: "GH_SECRET", deliver_to: "server" } }), key: "webhooks.provider.github", path: "resources.webhooks.gh.provider", free: false, starter: false, business: true },
    { name: "Stripe webhook", mutate: (m) => (m.resources.webhooks = { payments: { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", deliver_to: "server" } }), key: "webhooks.provider.stripe", path: "resources.webhooks.payments.provider", free: false, starter: true, business: true },
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
    manifest.resources.auth = { mode: "app_users", public_signup: true };
    const requirements = analyzeManifestRequirements(manifest);
    const comped = { ...planData().plans.free, features: { ...planData().plans.free.features, "auth.public_signup": true } };
    expect(evaluateRequirements(requirements, "free", comped)).toEqual([]);
    expect(evaluateRequirements(requirements, "free", planData().plans.free)).toHaveLength(1);
  });
});

describe("manifest schema validation", () => {
  test("app administration requires explicitly declared admin roles and enabled app auth", () => {
    const manifest = base();
    manifest.resources.auth = { mode: "app_users", roles: ["admin", "editor"], admin_roles: ["admin"] };
    expect(checkManifestDocument(manifest)).toMatchObject({ errors: [], schema_strict: [] });
    for (const auth of [
      { mode: "none", roles: ["admin"], admin_roles: ["admin"] },
      { mode: "app_users", roles: ["editor"], admin_roles: ["admin"] },
      { mode: "app_users", roles: ["admin"], admin_roles: ["admin", "admin"] }
    ]) {
      manifest.resources.auth = auth;
      expect(checkManifestDocument(manifest).errors.length).toBeGreaterThan(0);
    }
  });
  test("accepts file access policies and preserves private-store plan requirements", () => {
    const manifest = base();
    manifest.resources.files = { stores: { vault: { public: false, read_access: "signed_url", upload_access: "server_only" }, media: { public: true, upload_access: "server_only" } } };
    expect(checkManifestDocument(manifest)).toMatchObject({ errors: [], schema_strict: [] });
    expect(violationsFor(manifest, "starter")).toMatchObject({ "files.private_stores": "business" });
    expect(violationsFor(manifest, "business")).toEqual({});
  });

  test.each([
    { read_access: "signed_url" },
    { public: true, read_access: "signed_url" },
    { public: true, read_access: "authenticated" },
    { public: false, read_access: "owner" },
    { public: false, read_access: null },
    { upload_access: "public" },
    { upload_access: false }
  ])("refuses conflicting or invalid file policies: %j", (store) => {
    const manifest = base();
    manifest.resources.files = { stores: { vault: store } };
    const check = checkManifestDocument(manifest);
    expect(check.errors.length).toBeGreaterThan(0);
    expect(check.schema_strict).toEqual([]);
  });

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

  // Checks the bundled schema itself (what editors and other JSON Schema validators see through
  // `$schema`), not the CLI's view, which removes these keys before its schema check.
  // schemas/resource-manifest-v0.schema.json is generated by the private docs build and synced
  // here; it must keep accepting every top-level key the CLI reads.
  test("the bundled manifest schema accepts the top-level keys the CLI reads", () => {
    const document = {
      $schema: "https://docs.userland.fun/schemas/resource-manifest-v0.schema.json",
      app: { name: "Keys" },
      runtime: { static_root: "public" },
      message: "Launch copy refresh",
      files: [{ path: "public/index.html", content_type: "text/html; charset=utf-8" }],
      provenance: { source: "git", commit: "abc123" }
    };
    const check = checkManifestDocument(document);
    expect(check.errors).toEqual([]);
    expect(check.schema_strict).toEqual([]);
  });

  // The API refuses these (packages/shared CONTENT_TYPE_PATTERN): a `,` or `\` inside quotes, a
  // non-ASCII quoted value, or a line break around `;` can make a browser read another type.
  test("refuses content types the API refuses, in files and in allowed_content_types", () => {
    const refused = ['text/plain;a="x,y"', 'image/png;a="\\";b=",text/html;c="', "text/plain;\ncharset=utf-8", 'text/plain;a="café"'];
    const accepted = ["text/html; charset=utf-8", "text/plain ;charset=utf-8", 'text/plain; a="hello world"', "image/png"];
    const check = (contentType: string) =>
      checkManifestDocument({
        app: { name: "Types" },
        runtime: { static_root: "public" },
        files: [{ path: "public/index.html", content_type: contentType }],
        resources: { files: { stores: { media: { allowed_content_types: [contentType] } } } }
      });
    for (const contentType of refused) {
      expect(check(contentType).errors, contentType).toEqual([
        { code: "schema", manifest_path: "files[0].content_type", message: `${JSON.stringify(contentType)} must be a MIME type such as text/html or image/png` },
        { code: "schema", manifest_path: "resources.files.stores.media.allowed_content_types[0]", message: `${JSON.stringify(contentType)} must be a MIME type such as text/html or image/png` }
      ]);
    }
    for (const contentType of accepted) {
      expect(check(contentType).errors, contentType).toEqual([]);
    }
  });

  test("refuses private apps with the API's message, because Userland never kept them private", () => {
    const refused = checkManifestDocument({ app: { name: "Internal", visibility: "private" }, runtime: { static_root: "public" } });
    expect(refused.errors).toEqual([{ code: "invalid_app_manifest", manifest_path: "app.visibility", message: PRIVATE_APPS_REFUSED }]);
    expect(PRIVATE_APPS_REFUSED).toBe(
      "Private apps aren't available yet. Remove app.visibility or set it to public, and use sign-in with roles to limit who can see your app's pages and data."
    );
    // The bundled schema allows only "public", so editors refuse "private" too.
    expect(validateAgainstSchema({ app: { name: "Internal", visibility: "private" }, runtime: { static_root: "public" } }, manifestSchema())).toEqual([
      { code: "schema", manifest_path: "app.visibility", message: "must be one of: public" }
    ]);
    expect(checkManifestDocument({ app: { name: "Open", visibility: "public" }, runtime: { static_root: "public" } }).errors).toEqual([]);
    // The plan check never asks for a plan for it: no plan includes private apps.
    expect(analyzeManifestRequirements({ app: { name: "Internal", visibility: "private" }, runtime: { static_root: "public" }, resources: {} }).map((requirement) => requirement.key)).not.toContain(
      "private_apps"
    );
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
      "app.visibility": "must be one of: public",
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
      "resources.webhooks.gh.secret": "is required when provider is github"
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
    // Stripe signs its messages, so a `stripe` webhook needs the signing key's name too, on every target.
    expect(paths({ provider: "stripe", deliver_to: "server" })).toEqual(["resources.webhooks.hook.secret: is required when provider is stripe"]);
    expect(paths({ provider: "stripe", deliver_to: "job", job: "sync" })).toEqual(["resources.webhooks.hook.secret: is required when provider is stripe"]);
    expect(paths({ provider: "stripe", deliver_to: "server", secret: "STRIPE_WEBHOOK_SECRET" })).toEqual([]);
    expect(paths({ provider: "stripe", deliver_to: "job", job: "sync", secret: "STRIPE_WEBHOOK_SECRET" })).toEqual([]);
    expect(paths({ provider: "stripe", deliver_to: "job:sync", secret: "STRIPE_WEBHOOK_SECRET" })).toEqual([]);
  });

  test("accepts the senders the API accepts, and only those", () => {
    const check = (provider: string) =>
      checkManifestDocument({ app: { name: "x" }, runtime: { static_root: "public" }, resources: { webhooks: { hook: { provider, secret: "HOOK_SECRET", deliver_to: "server" } } } });
    for (const provider of ["generic_hmac", "github", "stripe"]) {
      expect(check(provider), provider).toMatchObject({ errors: [], schema_strict: [] });
    }
    // A sender the API does not know is still an error, before anything is uploaded.
    for (const provider of ["shopify", "Stripe", "stripe_v2"]) {
      expect(check(provider).errors.map((error) => error.manifest_path), provider).toEqual(["resources.webhooks.hook.provider"]);
    }
    const schemaProviders = (manifestSchema() as { $defs: { WebhookSpec: { oneOf: Array<{ properties: { provider: { const?: string; enum?: string[] } } }> } } }).$defs.WebhookSpec.oneOf.map(
      (variant) => variant.properties.provider.enum ?? [variant.properties.provider.const]
    );
    expect(schemaProviders).toEqual([["none"], ["generic_hmac", "github", "stripe"], ["none"], ["generic_hmac", "github", "stripe"], ["none"], ["generic_hmac", "github", "stripe"]]);
  });

  // The API's limits on these strings and lists (dwrtz/userland#426): app.summary at most 2,000
  // characters, at most 50 tags (each a resource name, so at most 64 characters), and a webhook's
  // reserved path at most 512 characters.
  test("holds app.summary, app.tags and a webhook's path to the API's limits", () => {
    const tags = (count: number) => Array.from({ length: count }, (_, n) => `tag-${n}`);
    const check = (app: Record<string, unknown>, webhook: Record<string, unknown> = { provider: "github", secret: "GH_SECRET", deliver_to: "server" }) =>
      checkManifestDocument({ app: { name: "Limits", ...app }, runtime: { static_root: "public" }, resources: { jobs: { sync: {} }, webhooks: { hook: webhook } } });
    expect(check({ summary: "s".repeat(2000), tags: [...tags(49), "t".repeat(64)] }, { provider: "none", deliver_to: "server", path: "p".repeat(512) })).toMatchObject({ errors: [], schema_strict: [] });
    expect(check({ summary: "s".repeat(2001) }).errors).toEqual([{ code: "schema", manifest_path: "app.summary", message: "must be at most 2,000 characters" }]);
    expect(check({ tags: tags(51) }).errors).toEqual([{ code: "schema", manifest_path: "app.tags", message: "must contain at most 50 items" }]);
    expect(check({ tags: ["t".repeat(65)] }).errors.map((error) => error.manifest_path)).toEqual(["app.tags[0]"]);
    // Every webhook shape carries the path limit, whatever the sender and delivery target.
    for (const webhook of [
      { provider: "none", deliver_to: "server" },
      { provider: "github", secret: "GH_SECRET", deliver_to: "server" },
      { provider: "none", deliver_to: "job", job: "sync" },
      { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", deliver_to: "job", job: "sync" },
      { provider: "none", deliver_to: "job:sync" },
      { provider: "generic_hmac", secret: "HOOK_SECRET", deliver_to: "job:sync" }
    ]) {
      expect(check({}, { ...webhook, path: "p".repeat(512) }).errors, JSON.stringify(webhook)).toEqual([]);
      expect(check({}, { ...webhook, path: "p".repeat(513) }).errors, JSON.stringify(webhook)).toEqual([
        { code: "schema", manifest_path: "resources.webhooks.hook.path", message: "must be at most 512 characters" }
      ]);
    }
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

describe("runtime.embed_origins", () => {
  const withOrigins = (embed_origins: unknown) => checkManifestDocument({ app: { name: "Embed" }, runtime: { static_root: "public", embed_origins } });

  // The same values and reasons as the API's checkEmbedOrigin tests.
  const accepted: Array<[string, string]> = [
    ["https://example.com", "https://example.com"],
    ["https://*.example.com", "https://*.example.com"],
    ["https://shop.example.co.uk:8443", "https://shop.example.co.uk:8443"],
    ["https://example.com:443", "https://example.com:443"],
    ["HTTPS://WWW.Example.COM", "https://www.example.com"],
    ["https://xn--bcher-kva.example", "https://xn--bcher-kva.example"],
    ["https://my-site.example.org", "https://my-site.example.org"],
    ["https://userland.fun.example.com", "https://userland.fun.example.com"],
    ["https://notuserland.fun", "https://notuserland.fun"]
  ];

  const refused: Array<[string, unknown, string]> = [
    // Anything that could end the source list, the directive, or the policy in the header.
    ["a second directive", "https://example.com; script-src *", "without spaces, quotes, commas or semicolons"],
    ["a directive without a space", "https://example.com;script-src", "without spaces, quotes, commas or semicolons"],
    ["a second policy", "https://example.com,frame-ancestors *", "without spaces, quotes, commas or semicolons"],
    ["a second source", "https://example.com https://other.example", "without spaces, quotes, commas or semicolons"],
    ["a keyword", "https://example.com 'unsafe-inline'", "without spaces, quotes, commas or semicolons"],
    ["'none'", "'none'", "without spaces, quotes, commas or semicolons"],
    ["a double quote", 'https://example.com"', "without spaces, quotes, commas or semicolons"],
    ["a leading space", " https://example.com", "without spaces, quotes, commas or semicolons"],
    ["a trailing newline", "https://example.com\n", "without spaces, quotes, commas or semicolons"],
    ["a header line break", "https://example.com\r\nx-frame-options: ALLOWALL", "without spaces, quotes, commas or semicolons"],
    ["a tab", "https://exa\tmple.com", "without spaces, quotes, commas or semicolons"],
    ["a non-breaking space", "https://example.com ", "without spaces, quotes, commas or semicolons"],
    ["'self'", "'self'", "is not needed"],
    ["'SELF' with spaces", " 'SELF' ", "is not needed"],
    // Sources wider than one site.
    ["every site", "*", "allowing every site is not supported"],
    ["every https site", "https://*", "allowing every site is not supported"],
    ["a scheme source", "https:", "allowing every site is not supported"],
    ["data:", "data:", "must start with https://"],
    ["blob:", "blob:", "must start with https://"],
    ["a wildcard over a top-level domain", "https://*.com", "must be https:// and a domain name"],
    ["a wildcard port", "https://example.com:*", "must be https:// and a domain name"],
    ["a wildcard inside the host", "https://a.*.example.com", "must be https:// and a domain name"],
    ["a wildcard without a dot", "https://*example.com", "must be https:// and a domain name"],
    ["two wildcards", "https://*.*.example.com", "must be https:// and a domain name"],
    // Not an https origin.
    ["http", "http://example.com", "must use https://"],
    ["no scheme", "example.com", "must start with https://"],
    ["another scheme", "wss://example.com", "must start with https://"],
    ["a scheme-relative source", "//example.com", "must start with https://"],
    ["a trailing slash", "https://example.com/", "without a path, query or fragment"],
    ["a path", "https://example.com/embed", "without a path, query or fragment"],
    ["a query", "https://example.com?frame=1", "without a path, query or fragment"],
    ["a fragment", "https://example.com#top", "without a path, query or fragment"],
    ["a backslash", "https://example.com\\embed", "must be https:// and a domain name"],
    ["userinfo", "https://user@example.com", "must be https:// and a domain name"],
    ["a percent-encoded host", "https://exa%6dple.com", "must be https:// and a domain name"],
    ["a non-ASCII host", "https://bücher.example", "must be https:// and a domain name"],
    ["a single label", "https://localhost", "must be https:// and a domain name"],
    ["a trailing dot", "https://example.com.", "must be https:// and a domain name"],
    ["a label starting with a hyphen", "https://-shop.example.com", "must be https:// and a domain name"],
    ["a label longer than 63 characters", `https://${"a".repeat(64)}.example.com`, "must be https:// and a domain name"],
    ["an empty label", "https://shop..example.com", "must be https:// and a domain name"],
    ["an IPv4 address", "https://127.0.0.1", "not an IP address"],
    ["an IPv6 address", "https://[::1]", "must be https:// and a domain name"],
    ["port 0", "https://example.com:0", "must be https:// and a domain name"],
    ["a port with a leading zero", "https://example.com:0443", "must be https:// and a domain name"],
    ["a port above 65535", "https://example.com:65536", "port above 65535"],
    ["an empty value", "", "must start with https://"],
    ["a value that is too long", `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example`, "must be at most 255 characters"],
    ["a number", 443, "must be a text value"],
    ["null", null, "must be a text value"],
    ["a list", ["https://example.com"], "must be a text value"]
  ];

  const userlandHosts = [
    "https://userland.fun",
    "https://www.userland.fun",
    "https://docs.userland.fun",
    "https://console.userland.fun",
    "https://api.userland.fun",
    "https://apps.userland.fun",
    "https://evil00000001.apps.userland.fun",
    "https://shop.apps.userland.fun",
    "https://shop.apps.userland.fun:8443",
    "https://*.userland.fun",
    "https://*.apps.userland.fun",
    "https://*.shop.apps.userland.fun",
    "HTTPS://Shop.Apps.Userland.Fun",
    "https://Shop.Apps.Userland.Fun",
    // App addresses on userland.link.
    "https://userland.link",
    "https://www.userland.link",
    "https://shop.userland.link",
    "https://evil00000001.userland.link",
    "https://example-check.userland.link:8443",
    "https://*.userland.link",
    "https://*.shop.userland.link",
    "HTTPS://Shop.UserLand.Link",
    "https://Shop.Userland.LINK"
  ];

  test.each(accepted)("accepts %s as %s", (value, origin) => {
    expect(checkEmbedOrigin(value)).toEqual({ ok: true, origin });
    expect(withOrigins([value]).errors).toEqual([]);
  });

  test.each(refused)("refuses %s with the API's message", (_name, value, reason) => {
    const check = checkEmbedOrigin(value);
    expect(check.ok).toBe(false);
    const message = (check as { reason: string }).reason;
    expect(message).toContain(reason);
    // The bundled schema catches some of these and the CLI's copy of the API rules catches the
    // rest; either way the error is reported once, with the API's code and message.
    expect(withOrigins(["https://www.example.com", value]).errors).toEqual([
      { code: "invalid_runtime_manifest", manifest_path: "runtime.embed_origins[1]", message: `runtime.embed_origins[1] ${message}.` }
    ]);
  });

  test.each(userlandHosts)("refuses the Userland address %s", (value) => {
    expect(checkEmbedOrigin(value)).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be a Userland address") });
    expect(withOrigins([value]).errors).toEqual([
      {
        code: "invalid_runtime_manifest",
        manifest_path: "runtime.embed_origins[0]",
        message: `runtime.embed_origins[0] (${JSON.stringify(value)}) cannot be a Userland address: other apps and Userland sites can never show this app in a frame.`
      }
    ]);
  });

  test("uses the API's exact wording", () => {
    expect(withOrigins(["https://example.com", "https://example.com; script-src *"]).errors).toEqual([
      {
        code: "invalid_runtime_manifest",
        manifest_path: "runtime.embed_origins[1]",
        message: 'runtime.embed_origins[1] ("https://example.com; script-src *") must be one origin, without spaces, quotes, commas or semicolons, for example https://example.com or https://*.example.com.'
      }
    ]);
    expect(withOrigins(["https://shop.apps.userland.fun"]).errors[0].message).toBe(
      'runtime.embed_origins[0] ("https://shop.apps.userland.fun") cannot be a Userland address: other apps and Userland sites can never show this app in a frame.'
    );
  });

  test("checks the list: an array of at most 20 sites, with every bad entry reported", () => {
    for (const value of ["https://example.com", "", null, 42, { "https://example.com": true }]) {
      expect(withOrigins(value).errors, JSON.stringify(value)).toEqual([
        { code: "invalid_runtime_manifest", manifest_path: "runtime.embed_origins", message: 'runtime.embed_origins must be a list of https origins, for example ["https://example.com"].' }
      ]);
    }

    const sites = Array.from({ length: EMBED_ORIGINS_MAX_COUNT }, (_, index) => `https://site${index}.example.com`);
    expect(withOrigins(sites).errors).toEqual([]);
    expect(withOrigins([...sites, "https://one-more.example.com"]).errors).toEqual([
      { code: "invalid_runtime_manifest", manifest_path: "runtime.embed_origins", message: "runtime.embed_origins can list at most 20 sites." }
    ]);

    expect(withOrigins([]).errors).toEqual([]);
    expect(withOrigins([]).schema_strict).toEqual([]);

    // The API stops at the first bad entry; the CLI lists them all, each at its own index.
    const several = withOrigins(["http://example.com", "https://example.com", "https://127.0.0.1", "https://shop.apps.userland.fun"]);
    expect(several.errors.map((error) => [error.code, error.manifest_path])).toEqual([
      ["invalid_runtime_manifest", "runtime.embed_origins[0]"],
      ["invalid_runtime_manifest", "runtime.embed_origins[2]"],
      ["invalid_runtime_manifest", "runtime.embed_origins[3]"]
    ]);

    // Other cross-field rules wait for schema errors to be fixed; bad entries are still all listed.
    const withSchemaError = checkManifestDocument({ app: { name: "Embed", visibility: "secret" }, runtime: { static_root: "public", embed_origins: ["https://127.0.0.1", "http://example.com"] } });
    expect(withSchemaError.errors.map((error) => [error.code, error.manifest_path])).toEqual([
      ["schema", "app.visibility"],
      ["invalid_runtime_manifest", "runtime.embed_origins[0]"],
      ["invalid_runtime_manifest", "runtime.embed_origins[1]"]
    ]);
  });

  test("warns about what the API accepts but the published schema does not", () => {
    // The API drops repeats and stores lowercase; the schema asks for neither.
    const repeated = withOrigins(["https://example.com", "https://example.com"]);
    expect(repeated.errors).toEqual([]);
    expect(repeated.schema_strict).toEqual([
      expect.objectContaining({ code: "schema_strict", manifest_path: "runtime.embed_origins", message: expect.stringContaining("must not contain duplicates (https://example.com)") })
    ]);

    const capitals = withOrigins(["HTTPS://www.example.com", "https://WWW.example.com"]);
    expect(capitals.errors).toEqual([]);
    expect(capitals.schema_strict).toEqual([
      expect.objectContaining({ code: "schema_strict", manifest_path: "runtime.embed_origins[0]", message: expect.stringContaining('"HTTPS://www.example.com" must start with https:// in lowercase letters') })
    ]);

    // A warning elsewhere does not hide the API's rules the schema does not cover.
    const mixed = checkManifestDocument({ app: { name: "Embed", description: "d" }, runtime: { static_root: "public", embed_origins: ["HTTPS://example.com", "https://127.0.0.1", "https://example.com:65536"] } });
    expect(mixed.errors.map((error) => error.manifest_path)).toEqual(["runtime.embed_origins[1]", "runtime.embed_origins[2]"]);
    expect(mixed.schema_strict.map((issue) => issue.manifest_path)).toEqual(["app.description", "runtime.embed_origins[0]"]);
  });

  test("returns the list as the API stores it: lowercase, without repeats", () => {
    expect(embedOriginList(["https://Example.com", "https://*.example.com", "https://example.com", "HTTPS://EXAMPLE.COM"])).toEqual(["https://example.com", "https://*.example.com"]);
    expect(embedOriginList(undefined)).toEqual([]);
    expect(embedOriginList([])).toEqual([]);
  });

  test("the bundled schema accepts every lowercase origin the API accepts", () => {
    const schema = manifestSchema() as { $defs: { RuntimeManifest: { properties: Record<string, { items: { pattern: string; not: { pattern: string }; maxLength: number } }> } } };
    const item = schema.$defs.RuntimeManifest.properties.embed_origins.items;
    for (const [, origin] of accepted) {
      expect(new RegExp(item.pattern, "u").test(origin), origin).toBe(true);
      expect(new RegExp(item.not.pattern, "u").test(origin), origin).toBe(false);
      expect(origin.length).toBeLessThanOrEqual(item.maxLength);
    }
  });

  // Editors and other tools that only read the bundled schema (through `$schema`) must refuse the
  // same Userland addresses and list length. JSON Schema patterns have no flag to ignore case, so the
  // schema spells each letter of userland.fun in both cases.
  test("the bundled schema refuses every Userland address in any letter case, and more than 20 sites", () => {
    const schema = manifestSchema();
    const schemaIssues = (embed_origins: unknown) => validateAgainstSchema({ app: { name: "Embed" }, runtime: { static_root: "public", embed_origins } }, schema);

    expect(schemaIssues(["https://OTHER-APP.APPS.USERLAND.FUN"])).toEqual([{ code: "schema", manifest_path: "runtime.embed_origins[0]", message: "is not allowed" }]);
    expect(schemaIssues(["https://OTHER-APP.USERLAND.LINK"])).toEqual([{ code: "schema", manifest_path: "runtime.embed_origins[0]", message: "is not allowed" }]);
    const lowercaseScheme = [
      ...userlandHosts,
      "https://userland.FUN",
      "https://Docs.Userland.Fun",
      "https://*.USERLAND.fun",
      "https://Shop.Apps.UserLand.Fun:8443",
      "https://userland.LINK",
      "https://*.USERLAND.link",
      "https://Shop.UserLand.Link:8443"
    ].filter((host) => host.startsWith("https://"));
    for (const host of lowercaseScheme) {
      expect(schemaIssues([host]).map((issue) => issue.manifest_path), host).toEqual(["runtime.embed_origins[0]"]);
    }
    // Sites that only look like Userland stay allowed.
    for (const host of [
      "https://notuserland.fun",
      "https://userland.fun.example.com",
      "https://USERLAND.FUN.example.com",
      "https://NotUserland.Fun",
      "https://notuserland.link",
      "https://userland.link.example.com",
      "https://shop.userland.links",
      "https://NotUserland.Link"
    ]) {
      expect(schemaIssues([host]), host).toEqual([]);
      expect(checkEmbedOrigin(host).ok, host).toBe(true);
    }

    const sites = Array.from({ length: EMBED_ORIGINS_MAX_COUNT }, (_, index) => `https://site${index}.example.com`);
    expect(schemaIssues(sites)).toEqual([]);
    expect(schemaIssues([...sites, "https://one-more.example.com"])).toEqual([
      { code: "schema", manifest_path: "runtime.embed_origins", message: `must contain at most ${EMBED_ORIGINS_MAX_COUNT} items` }
    ]);
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

    // Wrong types for keys the CLI ignores when publishing are schema_strict, not blocking.
    const wrongTypes = { ...manifest, $schema: 1, message: 42, provenance: "git", files: [{ path: "public/index.html", note: "x" }], extra: undefined };
    const badTypes = await validateAppDirectory(await appDir(wrongTypes));
    expect(badTypes.ok).toBe(true);
    expect(badTypes.errors).toEqual([]);
    expect(badTypes.warnings.map((warning) => [warning.code, warning.manifest_path])).toEqual([
      ["schema_strict", "$schema"],
      ["schema_strict", "message"],
      ["schema_strict", "provenance"],
      ["schema_strict", "files[0].note"]
    ]);
    const badTypesStrict = await validateAppDirectory(await appDir(wrongTypes), { strict: true });
    expect(badTypesStrict.ok).toBe(false);
    expect(badTypesStrict.errors.map((error) => error.manifest_path)).toEqual(["$schema", "message", "provenance", "files[0].note"]);

    // Malformed files change what is uploaded, so they still block.
    const badFiles = await validateAppDirectory(await appDir({ ...manifest, files: "public", extra: undefined }));
    expect(badFiles.errors).toEqual([{ code: "schema", manifest_path: "files", message: "must be an array of { path, content_type } objects" }]);
  });

  test("reports the sites allowed to embed the app, and blocks on a bad one", async () => {
    const listed = await validateAppDirectory(
      await appDir({ app: { name: "Embed" }, runtime: { static_root: "public", embed_origins: ["https://WWW.Example.com", "https://*.example.com", "https://www.example.com"] } }),
      { planKey: "free" }
    );
    expect(listed.ok).toBe(true);
    expect(listed.embed_origins).toEqual(["https://www.example.com", "https://*.example.com"]);
    // Embedding is on every plan.
    expect(listed.required_plan_key).toBe("free");
    expect(listed.violations).toEqual([]);

    const none = await validateAppDirectory(await appDir({ app: { name: "Embed" }, runtime: { static_root: "public" } }));
    expect(none.embed_origins).toEqual([]);
    const defaults = await validateAppDirectory(await appDir(undefined));
    expect(defaults.embed_origins).toEqual([]);

    const bad = await validateAppDirectory(await appDir({ app: { name: "Embed" }, runtime: { static_root: "public", embed_origins: ["https://shop.apps.userland.fun"] } }));
    expect(bad.ok).toBe(false);
    expect(bad.embed_origins).toBeNull();
    expect(bad.required_plan_key).toBeNull();
    expect(bad.errors).toEqual([
      {
        code: "invalid_runtime_manifest",
        manifest_path: "runtime.embed_origins[0]",
        message: 'runtime.embed_origins[0] ("https://shop.apps.userland.fun") cannot be a Userland address: other apps and Userland sites can never show this app in a frame.'
      }
    ]);
  });

  test("refuses symlinks listed in files and skips symlinks when walking the folder", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "userland-outside-"));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");

    // A symlink to a file outside the app folder (for example a template shipping
    // public/robots.txt -> ~/.userland/credentials.json) blocks validation and publishing.
    const listed = await appDir({ app: { name: "Links" }, runtime: { static_root: "public" }, files: [{ path: "public/index.html" }, { path: "public/leak.txt" }] });
    await fs.symlink(path.join(outside, "secret.txt"), path.join(listed, "public", "leak.txt"));
    const listedReport = await validateAppDirectory(listed);
    expect(listedReport.ok).toBe(false);
    expect(listedReport.release.file_count).toBe(1);
    expect(listedReport.errors).toEqual([
      expect.objectContaining({ code: "symlink", manifest_path: "files[1].path", file: "public/leak.txt", message: expect.stringContaining("is a symlink") })
    ]);
    expect(listedReport.warnings).toEqual([]);

    // Symlinks inside the app folder are refused too: they can point a public path at a private
    // file such as .env or server code.
    const inside = await appDir({ app: { name: "Links" }, runtime: { static_root: "public" }, files: [{ path: "public/index.html" }, { path: "public/alias.html" }] });
    await fs.symlink("index.html", path.join(inside, "public", "alias.html"));
    expect((await validateAppDirectory(inside)).errors).toEqual([expect.objectContaining({ code: "symlink", file: "public/alias.html" })]);

    // A symlinked folder above a listed file is refused the same way.
    const linkedFolder = await appDir({ app: { name: "Links" }, runtime: { static_root: "public" }, files: [{ path: "public/index.html" }, { path: "public/assets/secret.txt" }] });
    await fs.symlink(outside, path.join(linkedFolder, "public", "assets"));
    expect((await validateAppDirectory(linkedFolder)).errors).toEqual([
      expect.objectContaining({ code: "symlink", file: "public/assets/secret.txt", message: expect.stringContaining("is inside public/assets/, which is a symlink") })
    ]);

    const walked = await appDir({ app: { name: "Links" }, runtime: { static_root: "public" } });
    await fs.symlink(path.join(outside, "secret.txt"), path.join(walked, "public", "leak.txt"));
    const walkedReport = await validateAppDirectory(walked);
    expect(walkedReport.release.file_count).toBe(1);
    expect(walkedReport.warnings).toEqual([
      expect.objectContaining({ code: "symlinks_skipped", message: expect.stringContaining("1 symlink is not uploaded (public/leak.txt)") })
    ]);
  });

  test("leaves dotfiles and dot-folders out of a folder publish, except .well-known and dot-folders the manifest names", async () => {
    const dir = await appDir(
      { app: { name: "Dots" }, runtime: { static_root: "public" } },
      {
        "public/index.html": "<h1>hi</h1>",
        ".env": "STRIPE_SECRET_KEY=sk_live_abc",
        ".npmrc": "//registry.npmjs.org/:_authToken=npm_SECRET",
        ".git/config": '[remote "origin"] url = https://user:ghp_TOKEN@github.com/o/r',
        ".DS_Store": "x",
        "public/.env.local": "SECRET=1",
        "public/.well-known/security.txt": "Contact: mailto:security@userland.fun",
        "public/.well-known/.hidden": "x"
      }
    );
    const report = await validateAppDirectory(dir);
    expect(report.ok).toBe(true);
    expect(report.release.file_count).toBe(2);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "dotfiles_skipped",
        message: expect.stringContaining("6 dotfiles and dot-folders are not uploaded (.DS_Store, .env, .git/, .npmrc, public/.env.local, and 1 more)")
      })
    ]);
    expect(formatWarning(report.warnings[0])).toContain("list every release file in manifest.userland.json files");

    const listing = await listReleaseFiles(dir, { runtime: { static_root: "public" } }, { manifestFile: "manifest.userland.json" });
    expect(listing.files.map((file) => file.path)).toEqual(["public/.well-known/security.txt", "public/index.html"]);
    expect(listing.skippedDotfiles).toEqual([".DS_Store", ".env", ".git/", ".npmrc", "public/.env.local", "public/.well-known/.hidden"]);

    // A build folder such as .output/public named in runtime.static_root is still published.
    const nuxt = await appDir({ app: { name: "Nuxt" }, runtime: { static_root: ".output/public" } }, { ".output/public/index.html": "<h1>hi</h1>", ".output/public/.env": "x", ".cache/x": "y" });
    const nuxtListing = await listReleaseFiles(nuxt, { runtime: { static_root: ".output/public" } }, { manifestFile: "manifest.userland.json" });
    expect(nuxtListing.files.map((file) => file.path)).toEqual([".output/public/index.html"]);
    expect(nuxtListing.skippedDotfiles).toEqual([".cache/", ".output/public/.env"]);
    expect((await validateAppDirectory(nuxt)).ok).toBe(true);

    // Listing a dotfile in files uploads it on purpose.
    const listed = await appDir({ app: { name: "Dots" }, runtime: { static_root: "public" }, files: [{ path: "public/index.html" }, { path: "public/.nojekyll" }] }, { "public/index.html": "x", "public/.nojekyll": "" });
    const listedReport = await validateAppDirectory(listed);
    expect(listedReport.ok).toBe(true);
    expect(listedReport.release.file_count).toBe(2);
    expect(listedReport.warnings).toEqual([]);
  });

  test("refuses private keys found in a folder publish", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n";
    const dir = await appDir(
      { app: { name: "Keys" }, runtime: { static_root: "public" } },
      {
        "public/index.html": "<h1>hi</h1>",
        "certs/localhost-key.pem": pem,
        "certs/localhost.pem": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        "deploy/id_ed25519": "-----BEGIN OPENSSH PRIVATE KEY-----\n",
        "deploy/id_ed25519.pub": "ssh-ed25519 AAAA",
        "public/slides/talk.key": "PK\u0003\u0004 keynote",
        "server.p12": "binary"
      }
    );
    const report = await validateAppDirectory(dir);
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => [error.code, error.file])).toEqual([
      ["private_key", "certs/localhost-key.pem"],
      ["private_key", "deploy/id_ed25519"],
      ["private_key", "server.p12"]
    ]);
    expect(report.errors[0].message).toContain("looks like a private key");
    expect(report.release.file_count).toBe(4);
  });

  test("uploads a web app manifest.json and leaves out only the Userland manifest", async () => {
    const webManifest = JSON.stringify({ name: "Shop", short_name: "Shop", icons: [], start_url: "/", display: "standalone" });
    const dir = await appDir({ app: { name: "Pwa" }, runtime: { static_root: "public" } }, {
      "public/index.html": "<h1>hi</h1>",
      "public/manifest.json": webManifest,
      "public/data/manifest.userland.json": "{}",
      "manifest.json": webManifest
    });
    const report = await validateAppDirectory(dir);
    expect(report.ok).toBe(true);
    expect(report.manifest_file).toBe("manifest.userland.json");
    const listing = await listReleaseFiles(dir, {}, { manifestFile: "manifest.userland.json" });
    expect(listing.files.map((file) => file.path)).toEqual(["manifest.json", "public/data/manifest.userland.json", "public/index.html", "public/manifest.json"]);

    // Without manifest.userland.json, a top-level manifest.json with Userland keys is the older
    // manifest name and is not uploaded; a web app manifest.json is an ordinary file.
    const legacy = await appDir({ app: { name: "Legacy" }, runtime: { static_root: "public" } });
    await fs.rename(path.join(legacy, "manifest.userland.json"), path.join(legacy, "manifest.json"));
    const legacyReport = await validateAppDirectory(legacy);
    expect(legacyReport.manifest_file).toBe("manifest.json");
    expect(legacyReport.release.file_count).toBe(1);

    const pwaOnly = await appDir(undefined, { "public/index.html": "<h1>hi</h1>", "manifest.json": webManifest });
    const pwaReport = await validateAppDirectory(pwaOnly);
    expect(pwaReport.manifest_file).toBeNull();
    expect(pwaReport.release.file_count).toBe(2);
    expect(pwaReport.warnings.map((warning) => warning.code)).toEqual(["web_app_manifest", "missing_manifest"]);
    expect(await findManifest(pwaOnly)).toEqual({ ok: true, document: {}, file: null, webAppManifest: true });
  });

  test("checks release paths before any file is read", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "userland-outside-"));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    const dir = await appDir({ app: { name: "Paths" }, runtime: { static_root: "public" } });
    await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "public", "robots.txt"));

    expect(await releaseFileProblem(dir, "public/index.html")).toEqual({ ok: true, size: 11 });
    expect(await releaseFileProblem(dir, "../secret.txt")).toMatchObject({ ok: false, code: "unsafe_path" });
    expect(await releaseFileProblem(dir, "public/robots.txt")).toMatchObject({ ok: false, code: "symlink" });
    expect(await releaseFileProblem(dir, "public/missing.txt")).toMatchObject({ ok: false, code: "missing_file" });
    expect(await releaseFileProblem(dir, "public")).toMatchObject({ ok: false, code: "missing_file" });
  });

  test("applies plans to one analysis without re-reading the directory", async () => {
    const dir = await appDir({ app: { name: "Plan" }, runtime: { static_root: "public" }, resources: { auth: { mode: "app_users", public_signup: true } } });
    const analysis = await analyzeAppDirectory(dir);
    expect(analysis.report.plan).toBeNull();
    expect(analysis.requirements).not.toBeNull();
    await fs.rm(dir, { recursive: true, force: true });

    const free = applyPlan(analysis, { planKey: "free", planSource: "account" });
    expect(free.ok).toBe(false);
    expect(free.plan_source).toBe("account");
    expect(free.violations.map((finding) => finding.feature_key)).toEqual(["auth.public_signup"]);
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

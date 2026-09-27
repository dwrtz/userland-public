import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertCatalogEntry, assertEntryMatchesManifest } from "./catalog-entry.js";

const fixture = {
  slug: "tiny-store",
  title: "Tiny Store",
  summary: "Small storefront.",
  path: "examples/tiny-store",
  capabilities: ["server", "webhooks"],
  difficulty: "advanced",
  userland_api_version: "v0",
  required_plan: "starter",
  paid_features: ["webhooks.enabled"],
  launch_role: "capability-fixture"
};

const launch = {
  ...fixture,
  slug: "booking-app",
  path: "examples/booking-app",
  launch_role: "launch-example",
  demo_url: "https://booking-demo.apps.userland.fun/",
  page_url: "https://userland.fun/examples/booking-app/"
};

it("accepts the current catalog", async () => {
  const catalog = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "catalog.json"), "utf8")) as { examples: unknown[] };
  for (const entry of catalog.examples) expect(() => assertCatalogEntry(entry)).not.toThrow();
});

it("accepts capability fixtures and launch examples", () => {
  expect(() => assertCatalogEntry(fixture)).not.toThrow();
  expect(() => assertCatalogEntry({ ...fixture, required_plan: "free", paid_features: [] })).not.toThrow();
  expect(() => assertCatalogEntry(launch)).not.toThrow();
});

it.each([
  ["missing required_plan", { ...fixture, required_plan: undefined }, /required_plan/u],
  ["internal plan", { ...fixture, required_plan: "internal" }, /required_plan/u],
  ["unknown plan alias", { ...fixture, required_plan: "pro" }, /required_plan/u],
  ["missing paid_features", { ...fixture, paid_features: undefined }, /paid_features/u],
  ["unknown paid feature", { ...fixture, paid_features: ["webhooks"] }, /Unknown paid feature/u],
  ["duplicate paid feature", { ...fixture, paid_features: ["webhooks.enabled", "webhooks.enabled"] }, /more than once/u],
  ["free plan with paid features", { ...fixture, required_plan: "free" }, /must be \[\]/u],
  ["paid plan without paid features", { ...fixture, paid_features: [] }, /no paid_features/u],
  ["missing launch_role", { ...fixture, launch_role: undefined }, /launch_role/u],
  ["unknown launch_role", { ...fixture, launch_role: "demo" }, /launch_role/u],
  ["unknown field", { ...fixture, pricing: "free" }, /unknown catalog field/u],
  ["launch example without demo_url", { ...launch, demo_url: undefined }, /demo_url/u],
  ["launch example without page_url", { ...launch, page_url: undefined }, /page_url/u],
  ["http demo_url", { ...launch, demo_url: "http://booking-demo.apps.userland.fun/" }, /demo_url/u],
  ["demo_url on another host", { ...launch, demo_url: "https://booking-demo.example.com/" }, /demo_url/u],
  ["page_url for another slug", { ...launch, page_url: "https://userland.fun/examples/other/" }, /page_url/u],
  ["http page_url", { ...launch, page_url: "http://userland.fun/examples/booking-app/" }, /page_url/u]
])("rejects %s", (_name, entry, message) => {
  const cleaned = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
  expect(() => assertCatalogEntry(cleaned)).toThrow(message);
});

describe("assertEntryMatchesManifest", () => {
  const manifest = {
    app: { name: "Hooks", visibility: "public" },
    runtime: { static_root: "public", server_entry: "server/index.js" },
    resources: {
      secrets: { required: ["HOOK_SECRET"] },
      jobs: { handle: { trigger: "webhook" } },
      webhooks: { hook: { provider: "generic_hmac", secret: "HOOK_SECRET", deliver_to: "job", job: "handle" } }
    }
  };
  const entry = {
    ...fixture,
    capabilities: ["server", "secrets", "jobs", "webhooks"],
    required_plan: "starter",
    paid_features: ["webhooks.enabled", "webhooks.provider.generic_hmac", "webhooks.declared.max"]
  };

  it("accepts metadata computed from the manifest, in any order", () => {
    expect(() => assertEntryMatchesManifest(entry, manifest)).not.toThrow();
    expect(() => assertEntryMatchesManifest({ ...entry, paid_features: [...entry.paid_features].reverse() }, manifest)).not.toThrow();
  });

  it("rejects a required_plan that does not match the manifest", () => {
    expect(() => assertEntryMatchesManifest({ ...entry, required_plan: "business" }, manifest)).toThrow(/needs starter/u);
    expect(() => assertEntryMatchesManifest({ ...entry, required_plan: "free", paid_features: [] }, manifest)).toThrow(/needs starter/u);
  });

  it("rejects missing or extra paid_features", () => {
    expect(() => assertEntryMatchesManifest({ ...entry, paid_features: ["webhooks.enabled"] }, manifest)).toThrow(/paid_features must be/u);
    expect(() => assertEntryMatchesManifest({ ...entry, paid_features: [...entry.paid_features, "jobs.scheduled"] }, manifest)).toThrow(/paid_features must be/u);
  });

  it("rejects capabilities that disagree with the manifest", () => {
    expect(() => assertEntryMatchesManifest({ ...entry, capabilities: ["server", "jobs", "webhooks"] }, manifest)).toThrow(/add "secrets"/u);
    expect(() => assertEntryMatchesManifest({ ...entry, capabilities: [...entry.capabilities, "files"] }, manifest)).toThrow(/does not declare it/u);
  });
});

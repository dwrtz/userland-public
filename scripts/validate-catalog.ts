import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const allowedCapabilities = new Set(["static", "server", "auth", "data", "files", "secrets", "jobs", "webhooks", "rollback", "transactions"]);
const allowedDifficulty = new Set(["beginner", "intermediate", "advanced"]);

type CatalogEntry = {
  slug: string;
  title: string;
  summary: string;
  path: string;
  capabilities: string[];
  difficulty: string;
  userland_api_version: string;
};

const catalog = await readJson(path.join(root, "catalog.json"));
assertObject(catalog, "catalog.json must be an object.");
if (catalog.version !== 0) throw new Error("catalog.json version must be 0.");
if (catalog.userland_api_version !== "v0") throw new Error("catalog.json userland_api_version must be v0.");
if (!Array.isArray(catalog.examples)) throw new Error("catalog.json examples must be an array.");

const exampleDirs = await listExampleDirs();
const seen = new Set<string>();

for (const entry of catalog.examples) {
  assertCatalogEntry(entry);
  if (seen.has(entry.slug)) throw new Error(`Duplicate catalog slug: ${entry.slug}`);
  seen.add(entry.slug);
  const absoluteExamplePath = path.join(root, entry.path);
  if (!exampleDirs.has(entry.path)) throw new Error(`Catalog path does not exist: ${entry.path}`);
  const metadata = await readJson(path.join(absoluteExamplePath, "example.json"));
  assertCatalogEntry(metadata);
  if (JSON.stringify(metadata) !== JSON.stringify(entry)) {
    throw new Error(`${entry.path}/example.json must match catalog.json entry exactly.`);
  }
  for (const requiredFile of ["README.md", "AGENT.md", "manifest.userland.json"]) {
    await assertFile(path.join(absoluteExamplePath, requiredFile), `${entry.path} is missing ${requiredFile}`);
  }
}

for (const examplePath of exampleDirs) {
  if (examplePath === "examples/README.md") continue;
  const slug = path.basename(examplePath);
  if (!seen.has(slug)) throw new Error(`${examplePath} exists but is missing from catalog.json.`);
}

console.log(`Validated ${catalog.examples.length} catalog entries.`);

async function listExampleDirs(): Promise<Set<string>> {
  const examplesRoot = path.join(root, "examples");
  const entries = await readdir(examplesRoot, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => `examples/${entry.name}`));
}

function assertCatalogEntry(value: unknown): asserts value is CatalogEntry {
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
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function assertFile(filePath: string, message: string): Promise<void> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(message);
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
}

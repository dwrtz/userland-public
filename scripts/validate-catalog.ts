import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertCatalogEntry, assertEntryMatchesManifest } from "./catalog-entry.js";

const root = path.resolve(import.meta.dirname, "..");
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
  const manifest = await readJson(path.join(absoluteExamplePath, "manifest.userland.json"));
  assertObject(manifest, `${entry.path}/manifest.userland.json must be an object.`);
  assertEntryMatchesManifest(entry, manifest);
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

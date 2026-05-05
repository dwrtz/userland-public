import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const examplesRoot = path.join(root, "examples");

const exampleDirs = await readdir(examplesRoot, { withFileTypes: true });
let count = 0;

for (const entry of exampleDirs) {
  if (!entry.isDirectory()) continue;
  const examplePath = path.join(examplesRoot, entry.name);
  const manifestPath = path.join(examplePath, "manifest.userland.json");
  const manifest = await readJsonObject(manifestPath);
  validateManifest(manifest, entry.name);
  await validateReferencedFiles(examplePath, manifest, entry.name);
  count += 1;
}

console.log(`Validated ${count} manifests.`);

function validateManifest(manifest: Record<string, unknown>, slug: string): void {
  assertObject(manifest.app, `${slug}: app must be an object.`);
  if (typeof manifest.app.name !== "string" || manifest.app.name.length === 0) throw new Error(`${slug}: app.name is required.`);
  if (manifest.runtime !== undefined) {
    assertObject(manifest.runtime, `${slug}: runtime must be an object.`);
    if (manifest.runtime.static_root !== undefined && typeof manifest.runtime.static_root !== "string") {
      throw new Error(`${slug}: runtime.static_root must be a string.`);
    }
    if (manifest.runtime.server_entry !== undefined && typeof manifest.runtime.server_entry !== "string") {
      throw new Error(`${slug}: runtime.server_entry must be a string.`);
    }
  }
  if (manifest.resources !== undefined) assertObject(manifest.resources, `${slug}: resources must be an object.`);
  if (manifest.files !== undefined && !Array.isArray(manifest.files)) throw new Error(`${slug}: files must be an array.`);
}

async function validateReferencedFiles(examplePath: string, manifest: Record<string, unknown>, slug: string): Promise<void> {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const entry of files) {
    assertObject(entry, `${slug}: files entries must be objects.`);
    if (typeof entry.path !== "string" || entry.path.length === 0) throw new Error(`${slug}: files entries require path.`);
    validateReleasePath(entry.path, slug);
    await assertFile(path.join(examplePath, entry.path), `${slug}: missing file referenced by manifest: ${entry.path}`);
  }
  const runtime = isObject(manifest.runtime) ? manifest.runtime : {};
  for (const key of ["static_root", "server_entry"]) {
    const value = runtime[key];
    if (typeof value === "string") {
      validateReleasePath(value, slug);
      await assertPath(path.join(examplePath, value), `${slug}: runtime.${key} path does not exist: ${value}`);
    }
  }
}

function validateReleasePath(releasePath: string, slug: string): void {
  if (releasePath.startsWith("/") || releasePath.includes("..")) throw new Error(`${slug}: release path is unsafe: ${releasePath}`);
  if (releasePath === "_userland" || releasePath.startsWith("_userland/")) throw new Error(`${slug}: release path cannot be under _userland/: ${releasePath}`);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  assertObject(value, `${filePath} must contain a JSON object.`);
  return value;
}

async function assertFile(filePath: string, message: string): Promise<void> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(message);
}

async function assertPath(filePath: string, message: string): Promise<void> {
  const pathStat = await stat(filePath).catch(() => null);
  if (!pathStat) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new Error(message);
}


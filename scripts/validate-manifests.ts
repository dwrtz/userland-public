import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { manifestSchema, validateAgainstSchema, validateAppDirectory } from "../cli/src/validation.js";

// Every example must pass the CLI's own checks (`userland validate <dir> --strict`)
// and its manifest file, as written, must match the published JSON schema that
// editors and other JSON Schema validators see.
const root = path.resolve(import.meta.dirname, "..");
const examplesRoot = path.join(root, "examples");
const schema = manifestSchema();

// Optional slugs limit validation to specific examples: tsx scripts/validate-manifests.ts blog-cms tiny-store
const onlySlugs = new Set(process.argv.slice(2));
const exampleDirs = await readdir(examplesRoot, { withFileTypes: true });
let count = 0;

for (const entry of exampleDirs) {
  if (!entry.isDirectory()) continue;
  if (onlySlugs.size > 0 && !onlySlugs.has(entry.name)) continue;
  const examplePath = path.join(examplesRoot, entry.name);
  const manifest = JSON.parse(await readFile(path.join(examplePath, "manifest.userland.json"), "utf8")) as unknown;
  const schemaErrors = validateAgainstSchema(manifest, schema);
  if (schemaErrors.length > 0) {
    throw new Error(`${entry.name}: manifest.userland.json does not match schemas/resource-manifest-v0.schema.json:\n- ${schemaErrors.map(formatIssue).join("\n- ")}`);
  }
  const report = await validateAppDirectory(examplePath, { strict: true });
  if (report.manifest_file !== "manifest.userland.json") throw new Error(`${entry.name}: userland validate did not read manifest.userland.json.`);
  if (report.errors.length > 0 || report.warnings.length > 0) {
    throw new Error(`${entry.name}: userland validate --strict reported problems:\n- ${[...report.errors, ...report.warnings].map(formatIssue).join("\n- ")}`);
  }
  count += 1;
}

if (onlySlugs.size > 0 && count !== onlySlugs.size) throw new Error(`Unknown example slug in: ${[...onlySlugs].join(", ")}`);
console.log(`Validated ${count} manifests.`);

function formatIssue(issue: { manifest_path: string; file?: string; message: string }): string {
  const where = issue.file ?? issue.manifest_path;
  return where ? `${where}: ${issue.message}` : issue.message;
}

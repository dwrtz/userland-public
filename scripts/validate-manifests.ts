import { readdir } from "node:fs/promises";
import path from "node:path";
import { committedFiles, exampleProblems } from "./example-manifests.js";

// Every example must pass the CLI's own checks (`userland validate <dir> --strict`)
// and its manifest file, as written, must match the published JSON schema that
// editors and other JSON Schema validators see. Local files git does not track, such as
// a gitignored .env or a .DS_Store, do not fail the check (see exampleProblems).
const root = path.resolve(import.meta.dirname, "..");
const examplesRoot = path.join(root, "examples");

// Optional slugs limit validation to specific examples: tsx scripts/validate-manifests.ts blog-cms tiny-store
const onlySlugs = new Set(process.argv.slice(2));
const exampleDirs = await readdir(examplesRoot, { withFileTypes: true });
let count = 0;

for (const entry of exampleDirs) {
  if (!entry.isDirectory()) continue;
  if (onlySlugs.size > 0 && !onlySlugs.has(entry.name)) continue;
  const examplePath = path.join(examplesRoot, entry.name);
  const problems = await exampleProblems(examplePath, committedFiles(examplePath));
  if (problems.length > 0) {
    throw new Error(`${entry.name}:\n- ${problems.join("\n- ")}`);
  }
  count += 1;
}

if (onlySlugs.size > 0 && count !== onlySlugs.size) throw new Error(`Unknown example slug in: ${[...onlySlugs].join(", ")}`);
console.log(`Validated ${count} manifests.`);

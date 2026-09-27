import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const examplesRoot = path.join(root, "examples");
const requiredDocsLinks = [
  "https://docs.userland.fun/llms.txt",
  "https://docs.userland.fun/quickstarts/from-example",
  "https://docs.userland.fun/reference/resource-manifest",
  "https://docs.userland.fun/reference/runtime-ctx",
  "https://docs.userland.fun/reference/cli",
  "https://docs.userland.fun/reference/agent-skills",
  "https://docs.userland.fun/guides/troubleshooting"
];
const forbiddenText = [
  "github.com/userland-fun/userland-examples",
  "github.com/<ORG>",
  "workers/docs",
  "workers/marketing",
  // Old password-based CLI auth. The CLI now signs in through the browser with `userland login`.
  "--password",
  "--username",
  "keychain"
];

// Plans that are off sale. Example docs must never offer them or suggest them
// as an upgrade; features beyond Business Plus say "contact support" instead.
const retiredPlanPatterns = [/`agency`/iu, /\bagency plan\b/iu, /\bplan[^.\n]{0,40}\bagency\b/iu, /\bassisted launch\b/iu];

function assertNoRetiredPlans(file: string, body: string): void {
  for (const pattern of retiredPlanPatterns) {
    const match = body.match(pattern);
    if (match) throw new Error(`${file} mentions a plan that is not on sale: ${match[0]}`);
  }
}

// Optional slugs limit validation to specific examples: tsx scripts/validate-links.ts blog-cms tiny-store
const onlySlugs = new Set(process.argv.slice(2));
let checked = 0;

for (const entry of await readdir(examplesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (onlySlugs.size > 0 && !onlySlugs.has(entry.name)) continue;
  for (const file of ["README.md", "AGENT.md"]) {
    const relativePath = `examples/${entry.name}/${file}`;
    const body = await readFile(path.join(root, relativePath), "utf8");
    for (const link of requiredDocsLinks) {
      if (!body.includes(link)) {
        throw new Error(`${relativePath} is missing required docs link: ${link}`);
      }
    }
    for (const forbidden of forbiddenText) {
      if (body.includes(forbidden)) {
        throw new Error(`${relativePath} contains stale reference: ${forbidden}`);
      }
    }
    assertNoRetiredPlans(relativePath, body);
    checked += 1;
  }
}

for (const file of ["README.md", "examples/README.md", "cli/README.md", "skills.catalog.json", "catalog.json"]) {
  const body = await readFile(path.join(root, file), "utf8");
  for (const forbidden of forbiddenText) {
    if (body.includes(forbidden)) {
      throw new Error(`${file} contains stale reference: ${forbidden}`);
    }
  }
  assertNoRetiredPlans(file, body);
}

console.log(`Validated docs links in ${checked} example files.`);

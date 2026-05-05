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
  "workers/marketing"
];

let checked = 0;

for (const entry of await readdir(examplesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
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
    checked += 1;
  }
}

for (const file of ["README.md", "cli/README.md", "skills.catalog.json", "catalog.json"]) {
  const body = await readFile(path.join(root, file), "utf8");
  for (const forbidden of forbiddenText) {
    if (body.includes(forbidden)) {
      throw new Error(`${file} contains stale reference: ${forbidden}`);
    }
  }
}

console.log(`Validated docs links in ${checked} example files.`);

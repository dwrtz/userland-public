import { promises as fs } from "node:fs";

const cliSource = await fs.readFile("cli/src/index.ts", "utf8");
const cliReadme = await fs.readFile("cli/README.md", "utf8");

const requiredSourcePatterns = [
  'subcommand === "publish"',
  'subcommand === "list"',
  'subcommand === "releases"',
  'subcommand === "rollback"',
  'subcommand === "secrets" && rest[0] === "set"',
  'subcommand === "events"',
  'command === "publish"',
  'command === "releases" || command === "versions"'
];

const requiredReadmeSnippets = [
  "npm run userland -- apps publish",
  "npm run userland -- apps list",
  "npm run userland -- apps releases",
  "npm run userland -- apps rollback",
  "npm run userland -- apps secrets set",
  "npm run userland -- apps events",
  "https://docs.userland.fun/reference/cli"
];

const failures = [
  ...missing("cli/src/index.ts", cliSource, requiredSourcePatterns),
  ...missing("cli/README.md", cliReadme, requiredReadmeSnippets)
];

if (failures.length > 0) {
  throw new Error(`CLI validation failed:\n${failures.join("\n")}`);
}

function missing(filePath: string, contents: string, snippets: string[]): string[] {
  return snippets.filter((snippet) => !contents.includes(snippet)).map((snippet) => `${filePath} is missing ${JSON.stringify(snippet)}`);
}

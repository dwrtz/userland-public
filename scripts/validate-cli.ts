import { promises as fs } from "node:fs";

const cliSource = await fs.readFile("cli/src/index.ts", "utf8");
const cliReadme = await fs.readFile("cli/README.md", "utf8");
const cliPackage = JSON.parse(await fs.readFile("cli/package.json", "utf8")) as {
  bin?: Record<string, string>;
  files?: string[];
  name?: string;
  private?: boolean;
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
};

const requiredSourcePatterns = [
  'subcommand === "publish"',
  'subcommand === "list"',
  'subcommand === "releases"',
  'subcommand === "rollback"',
  'subcommand === "secrets" && rest[0] === "set"',
  'subcommand === "events"',
  'command === "accounts"',
  'command === "support"',
  'subcommand === "open"',
  'subcommand === "use"',
  'subcommand === "signup"',
  'subcommand === "login"',
  'subcommand === "status"',
  'subcommand === "save-key"',
  'subcommand === "logout"',
  'command === "signup"',
  'command === "login"',
  'command === "publish"',
  'command === "--version"',
  'command === "releases" || command === "versions"'
];

const requiredReadmeSnippets = [
  "userland --version",
  "userland signup",
  "userland login",
  "userland auth status",
  "userland auth save-key",
  "userland auth logout",
  "userland accounts list",
  "userland accounts use",
  "userland support open",
  "userland apps publish",
  "userland apps list",
  "userland apps releases",
  "userland apps rollback",
  "userland apps secrets set",
  "userland apps events",
  "USERLAND_ACCOUNT_ID",
  "--account",
  "npm run userland -- --version",
  "npm run userland -- signup",
  "npm run userland -- login",
  "npm run userland -- auth status",
  "npm run userland -- auth save-key",
  "npm run userland -- auth logout",
  "npm run userland -- accounts list",
  "npm run userland -- accounts use",
  "npm run userland -- support open",
  "npm run userland -- apps publish",
  "npm run userland -- apps list",
  "npm run userland -- apps releases",
  "npm run userland -- apps rollback",
  "npm run userland -- apps secrets set",
  "npm run userland -- apps events",
  "browser device-authorization flow",
  "does not store platform passwords",
  "npm install -g @userland.fun/cli",
  "https://docs.userland.fun/reference/cli"
];

const operatorCommand = "ops";
const operatorApiPrefix = `/v0/${operatorCommand}`;
const operatorCliPrefix = `userland ${operatorCommand}`;

const forbiddenSourcePatterns = [
  `command === "${operatorCommand}"`,
  operatorApiPrefix,
  operatorCliPrefix
];

const forbiddenReadmeSnippets = [
  operatorApiPrefix,
  operatorCliPrefix,
  "Internal/platform-admin only operations"
];

const failures = [
  ...missing("cli/src/index.ts", cliSource, requiredSourcePatterns),
  ...missing("cli/README.md", cliReadme, requiredReadmeSnippets),
  ...present("cli/src/index.ts", cliSource, forbiddenSourcePatterns),
  ...present("cli/README.md", cliReadme, forbiddenReadmeSnippets),
  ...validatePackage()
];

if (failures.length > 0) {
  throw new Error(`CLI validation failed:\n${failures.join("\n")}`);
}

function missing(filePath: string, contents: string, snippets: string[]): string[] {
  return snippets.filter((snippet) => !contents.includes(snippet)).map((snippet) => `${filePath} is missing ${JSON.stringify(snippet)}`);
}

function present(filePath: string, contents: string, snippets: string[]): string[] {
  return snippets.filter((snippet) => contents.includes(snippet)).map((snippet) => `${filePath} must not include ${JSON.stringify(snippet)}`);
}

function validatePackage(): string[] {
  const errors: string[] = [];
  if (cliPackage.name !== "@userland.fun/cli") {
    errors.push("cli/package.json must publish as @userland.fun/cli");
  }
  if (cliPackage.private === true) {
    errors.push("cli/package.json must not be private");
  }
  if (cliPackage.bin?.userland !== "dist/index.js") {
    errors.push("cli/package.json bin.userland must point to dist/index.js");
  }
  if (!cliPackage.files?.includes("dist")) {
    errors.push("cli/package.json files must include dist");
  }
  if (cliPackage.publishConfig?.access !== "public") {
    errors.push("cli/package.json publishConfig.access must be public");
  }
  if (!cliPackage.scripts?.prepack?.includes("build")) {
    errors.push("cli/package.json must build before packing");
  }
  return errors;
}

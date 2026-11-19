import { promises as fs } from "node:fs";

const cliSource = await fs.readFile("cli/src/index.ts", "utf8");
const cliReadme = await fs.readFile("cli/README.md", "utf8");
const rootPackage = JSON.parse(await fs.readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
const cliPackage = JSON.parse(await fs.readFile("cli/package.json", "utf8")) as {
  bin?: Record<string, string>;
  files?: string[];
  name?: string;
  private?: boolean;
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
  engines?: {node?:string};
};

const requiredSourcePatterns = ["nativeCommand(","nativeDataCommand(","nativeDomainsCommand(","nativeSecretsCommand(","accountMembershipCommand(",'command === "auth"','command === "--version"'];
const requiredReadmeSnippets = ["Node 22","userland --version","userland login","userland auth status","userland auth save-key","userland auth logout","userland auth logout --revoke","userland context","userland apps apply","userland apps get","userland operations get","userland apps run","USERLAND_ACCOUNT_ID","USERLAND_API_KEY","--account","browser device-authorization flow","does not store platform passwords","https://docs.userland.fun/native-guide.md"];

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
  "Internal/platform-admin only operations",
  "sends the directory to the API without local checks"
];

// The current CLI and its documentation must omit the retired Agency plan.
const rootReadme = await fs.readFile("README.md", "utf8");
const retiredPlanFailures = Object.entries({ "cli/src/index.ts": cliSource, "cli/README.md": cliReadme, "README.md": rootReadme })
  .filter(([, contents]) => /\bagency\b/iu.test(contents))
  .map(([filePath]) => `${filePath} must not mention the retired Agency plan`);

const failures = [
  ...retiredPlanFailures,
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
  if (rootPackage.scripts?.["cli:build"]?.includes("schemas/")) {
    errors.push("The native CLI must not package retired runtime schemas or plan artifacts.");
  }
  if(cliPackage.engines?.node !== ">=22 <23") errors.push("Advertise only the verified Node22 runtime.");
  return errors;
}

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Builds the generated parts of the Userland plugin (plugins/userland) for Claude and Codex:
// - skills/: a copy of every skill in .agents/skills, the one source the repo-scoped skills also use;
// - LICENSE: a copy of the repo's MIT license.
// The manifests, .mcp.json and README are written by hand.
//
//   npx tsx scripts/build-plugin.ts          writes them
//   npx tsx scripts/build-plugin.ts --check  fails when they differ from their sources (part of npm test)

export const root = path.resolve(import.meta.dirname, "..");
export const pluginDir = path.join(root, "plugins", "userland");
const skillsSource = path.join(root, ".agents", "skills");

/** The generated files, by path inside the plugin, with their contents. */
export async function expectedGeneratedFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of await listFiles(skillsSource)) {
    files.set(path.posix.join("skills", file), await readFile(path.join(skillsSource, file), "utf8"));
  }
  files.set("LICENSE", await readFile(path.join(root, "LICENSE"), "utf8"));
  return files;
}

/** What differs between the generated files and their sources; empty when they match. */
export async function pluginDrift(): Promise<string[]> {
  const expected = await expectedGeneratedFiles();
  const problems: string[] = [];
  const actualSkills = new Set((await listFiles(path.join(pluginDir, "skills"))).map((file) => path.posix.join("skills", file)));
  for (const [file, contents] of expected) {
    const actual = await readFile(path.join(pluginDir, file), "utf8").catch(() => null);
    if (actual === null) problems.push(`plugins/userland/${file} is missing.`);
    else if (actual !== contents) problems.push(`plugins/userland/${file} differs from its source.`);
  }
  for (const file of actualSkills) {
    if (!expected.has(file)) problems.push(`plugins/userland/${file} has no source in .agents/skills.`);
  }
  return problems;
}

export async function writePlugin(): Promise<void> {
  await rm(path.join(pluginDir, "skills"), { recursive: true, force: true });
  for (const [file, contents] of await expectedGeneratedFiles()) {
    const target = path.join(pluginDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

/** Every file under a folder, as paths relative to it with forward slashes, sorted. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (process.argv.includes("--check")) {
    const problems = await pluginDrift();
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      console.error("Run `npm run plugin:build` to regenerate plugins/userland.");
      process.exit(1);
    }
    console.log("plugins/userland matches .agents/skills and LICENSE.");
  } else {
    await writePlugin();
    console.log("Wrote plugins/userland/skills and plugins/userland/LICENSE.");
  }
}

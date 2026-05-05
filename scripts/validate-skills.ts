import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const skillsRoot = path.join(root, ".agents", "skills");
const catalog = JSON.parse(await readFile(path.join(root, "skills.catalog.json"), "utf8")) as {
  skills?: Array<{ name?: string; path?: string; description?: string }>;
};

if (!Array.isArray(catalog.skills)) throw new Error("skills.catalog.json skills must be an array.");

const dirs = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const catalogNames = catalog.skills.map((skill) => skill.name).sort();
if (JSON.stringify(dirs) !== JSON.stringify(catalogNames)) {
  throw new Error(".agents/skills directories must match skills.catalog.json names.");
}

const seen = new Set<string>();
for (const skill of catalog.skills) {
  if (!skill.name || !skill.path || !skill.description) throw new Error("Each skill catalog entry needs name, path, and description.");
  if (seen.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
  seen.add(skill.name);
  if (skill.path !== `.agents/skills/${skill.name}`) throw new Error(`Skill path mismatch for ${skill.name}.`);
  const skillPath = path.join(root, skill.path, "SKILL.md");
  await assertFile(skillPath, `${skill.name} is missing SKILL.md`);
  const body = await readFile(skillPath, "utf8");
  const frontmatter = parseFrontmatter(body, skill.name);
  if (frontmatter.name !== skill.name) throw new Error(`${skill.name}: frontmatter name must match directory.`);
  if (frontmatter.description !== skill.description) throw new Error(`${skill.name}: frontmatter description must match catalog.`);
  for (const required of ["Userland API version: v0", "Inputs", "Outputs", "Steps", "Commands", "Validation checklist", "Safety rules"]) {
    if (!body.includes(required)) throw new Error(`${skill.name}: missing section ${required}.`);
  }
  if (body.includes("TODO") || body.includes("example.com")) throw new Error(`${skill.name}: contains placeholder text.`);
}

console.log(`Validated ${catalog.skills.length} skills.`);

function parseFrontmatter(body: string, name: string): Record<string, string> {
  const match = body.match(/^---\n([\s\S]*?)\n---/u);
  if (!match) throw new Error(`${name}: missing frontmatter.`);
  const output: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    output[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^"|"$/gu, "");
  }
  if (!output.name || !output.description) throw new Error(`${name}: frontmatter needs name and description.`);
  return output;
}

async function assertFile(filePath: string, message: string): Promise<void> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(message);
}


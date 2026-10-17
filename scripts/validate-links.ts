import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const catalog = JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8")) as { examples: Array<{slug:string;path:string}> };
const onlySlugs = new Set(process.argv.slice(2));
const requiredDocsLinks = ["https://docs.userland.fun/native-guide.md", "https://docs.userland.fun/reference/cli"];
const forbidden = [/userland\s+validate\b/u, /userland\s+apps\s+publish\b/u, /manifest\.userland\.json/u, /@userland\/(runtime|sdk)/u, /github\.com\/userland-fun\/userland-examples/u];
let checked = 0;
for (const example of catalog.examples) {
  if (onlySlugs.size && !onlySlugs.has(example.slug)) continue;
  for (const name of ["README.md", "AGENT.md"]) {
    const file = `${example.path}/${name}`;
    const body = await readFile(path.join(root, file), "utf8");
    for (const link of requiredDocsLinks) if (!body.includes(link)) throw new Error(`${file} misses ${link}`);
    for (const pattern of forbidden) if (pattern.test(body)) throw new Error(`${file} advertises retired workflow: ${pattern}`);
    checked++;
  }
}
if (onlySlugs.size && checked !== onlySlugs.size * 2) throw new Error("Unknown selected example");
console.log(`Validated native docs links in ${checked} example files.`);

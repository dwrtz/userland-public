import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { committedFiles, exampleProblems } from "./example-manifests.js";

const helloStatic = path.resolve(import.meta.dirname, "..", "examples", "hello-static");
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "userland-example-"));
  await cp(helloStatic, dir, { recursive: true });
  // Local files that are not part of the example: a gitignored .env and a macOS .DS_Store.
  await writeFile(path.join(dir, ".env"), "MODEL_API_KEY=local\n");
  await writeFile(path.join(dir, "public", ".DS_Store"), "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("lists the example's committed files", () => {
  const files = committedFiles(helloStatic);
  expect(files).toContain("manifest.userland.json");
  expect(files).toContain("public/index.html");
});

it("ignores local dotfiles that are not committed", async () => {
  const committed = committedFiles(helloStatic);
  expect(committed).not.toBeNull();
  expect(await exampleProblems(dir, committed)).toEqual([]);
});

it("fails when a committed file would be left out of a folder publish", async () => {
  const committed = [...(committedFiles(helloStatic) ?? []), "public/.DS_Store"];
  expect(await exampleProblems(dir, committed)).toEqual([
    "public/.DS_Store is committed, but publishing the folder leaves out dotfiles, so it would not be uploaded."
  ]);
});

it("keeps the dotfile warning when git cannot list committed files", async () => {
  const problems = await exampleProblems(dir, null);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("userland validate --strict: 2 dotfiles and dot-folders are not uploaded (.env, public/.DS_Store).");
});

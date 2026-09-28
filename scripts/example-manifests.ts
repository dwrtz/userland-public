import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listReleaseFiles, manifestSchema, validateAgainstSchema, validateAppDirectory } from "../cli/src/validation.js";

const schema = manifestSchema();

/**
 * Problems that fail `npm test` for one example folder. Its manifest.userland.json must match the
 * published JSON schema that editors and other validators see, and `userland validate --strict` must
 * report no errors or warnings.
 *
 * One exception: `userland validate` warns about every dotfile a folder publish leaves out, including
 * local files that are not part of the example, such as a gitignored .env or a macOS .DS_Store. When
 * `committedFiles` (the example's files in git, as paths inside the example folder) is known, that
 * warning is replaced by a check that no committed file would be left out. Pass null when git cannot
 * list them, and the warning counts as usual.
 */
export async function exampleProblems(examplePath: string, committedFiles: readonly string[] | null): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(examplePath, "manifest.userland.json"), "utf8")) as Record<string, unknown>;
  const problems = validateAgainstSchema(manifest, schema).map((issue) => `manifest.userland.json does not match schemas/resource-manifest-v0.schema.json: ${formatIssue(issue)}`);
  if (problems.length > 0) return problems;

  const report = await validateAppDirectory(examplePath, { strict: true });
  if (report.manifest_file !== "manifest.userland.json") problems.push("userland validate did not read manifest.userland.json.");
  const warnings = committedFiles === null ? report.warnings : report.warnings.filter((warning) => warning.code !== "dotfiles_skipped");
  problems.push(...[...report.errors, ...warnings].map((issue) => `userland validate --strict: ${formatIssue(issue)}`));

  if (committedFiles !== null) {
    const listing = await listReleaseFiles(examplePath, manifest, { manifestFile: report.manifest_file });
    const committed = new Set(committedFiles);
    for (const skipped of listing.skippedDotfiles) {
      const isCommitted = skipped.endsWith("/") ? committedFiles.some((file) => file.startsWith(skipped)) : committed.has(skipped);
      if (isCommitted) problems.push(`${skipped} is committed, but publishing the folder leaves out dotfiles, so it would not be uploaded.`);
    }
  }
  return problems;
}

/**
 * Files git tracks under `dir`, as paths inside `dir` with "/" separators, or null when git cannot
 * list them (for example outside a git checkout).
 */
export function committedFiles(dir: string): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function formatIssue(issue: { manifest_path: string; file?: string; message: string }): string {
  const where = issue.file ?? issue.manifest_path;
  return where ? `${where}: ${issue.message}` : issue.message;
}

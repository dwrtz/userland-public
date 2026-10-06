import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { releasePathError } from "./validation.js";

// Helpers for `userland apps download`: the content type the CLI gives a file, the manifest a
// downloaded folder needs to publish again unchanged, and writing a version's files into a folder
// safely (paths checked, symlinks never followed, every file's size and SHA-256 checked).

/** The content type `apps publish` gives a file that has no `content_type` in the manifest. */
export function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8"
  };
  return types[ext] ?? "application/octet-stream";
}

export const MANIFEST_SCHEMA_URL = "https://docs.userland.fun/schemas/resource-manifest-v0.schema.json";

export interface VersionFile {
  path: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
}

/**
 * manifest.userland.json for a downloaded version, as the API's zip download builds it: the stored
 * app, runtime and resources settings, the version's message, and a `files` list naming every file
 * (so exactly those are published again), with a `content_type` only where this CLI would guess
 * another from the file's extension.
 */
export function rebuiltManifest(stored: Record<string, unknown>, message: string | null, files: readonly Pick<VersionFile, "path" | "content_type">[]): Record<string, unknown> {
  const manifest: Record<string, unknown> = { $schema: MANIFEST_SCHEMA_URL };
  for (const key of ["app", "runtime", "resources"]) {
    if (stored[key] !== undefined) manifest[key] = stored[key];
  }
  if (message !== null && message.trim() !== "") manifest.message = message;
  manifest.files = files.map((file) => (contentTypeForPath(file.path) === file.content_type ? { path: file.path } : { path: file.path, content_type: file.content_type }));
  return manifest;
}

/** The secret names a version requires. Their values are never part of a version. */
export function requiredSecretNames(stored: Record<string, unknown>): string[] {
  const resources = isPlainObject(stored.resources) ? stored.resources : {};
  const secrets = isPlainObject(resources.secrets) ? resources.secrets : {};
  return Array.isArray(secrets.required) ? secrets.required.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
}

/**
 * Where a version's file goes inside `dir`, or why it can't go anywhere. The API's paths are
 * checked again here, so a tampered or broken answer never writes outside the folder: no absolute
 * paths, `..`, backslashes, empty segments, NUL, or drive letters, and the result must stay inside.
 */
export function targetPath(dir: string, releasePath: string): string {
  const problem = releasePathError(releasePath) ?? (/^[A-Za-z]:/u.test(releasePath) ? "drive letters are not allowed" : undefined);
  if (problem) {
    throw new Error(`The API sent a file path the CLI won't write, ${JSON.stringify(releasePath)}: ${problem}. Nothing was downloaded.`);
  }
  const root = path.resolve(dir);
  const target = path.resolve(root, ...releasePath.split("/"));
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`The API sent a file path outside the folder, ${JSON.stringify(releasePath)}. Nothing was downloaded.`);
  }
  return target;
}

/**
 * Creates the folders on the way to a file inside `root`, refusing any that is a symlink or a file,
 * so writing into an existing folder (--force) can't be sent elsewhere by a link already there.
 */
export async function ensureParentFolders(root: string, target: string): Promise<void> {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) {
      await fs.mkdir(current);
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${current} is ${stat.isSymbolicLink() ? "a symlink" : "not a folder"}, so the CLI won't write into it.`);
    }
  }
}

/**
 * Writes a file's bytes, never through a symlink, checking its size and SHA-256 as they arrive. A file
 * that doesn't match is removed and the download fails: what's on disk is always what was published.
 */
export async function writeCheckedFile(target: string, chunks: AsyncIterable<Uint8Array>, expected: Pick<VersionFile, "path" | "size_bytes" | "sha256">): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing && !existing.isFile()) {
    throw new Error(`${target} is ${existing.isSymbolicLink() ? "a symlink" : "not a regular file"}, so the CLI won't write over it.`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o644);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > expected.size_bytes) break;
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  const sha256 = hash.digest("hex");
  if (size !== expected.size_bytes || sha256 !== expected.sha256) {
    await fs.rm(target, { force: true });
    throw new Error(
      `${expected.path} arrived ${size !== expected.size_bytes ? `with ${size} bytes instead of ${expected.size_bytes}` : "with a different SHA-256 than the version records"}. It was not kept; run the command again.`
    );
  }
}

/** Whether a folder is missing or empty (a folder holding only .DS_Store counts as empty). */
export async function folderIsEmpty(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.every((entry) => entry === ".DS_Store");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

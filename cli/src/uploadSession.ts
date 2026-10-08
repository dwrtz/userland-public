import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";

// Publishing a large bundle through an upload session (dwrtz/userland#250 and #286, NEW-a). One JSON
// `PUT /v0/apps` carries every file as base64, which can't hold the releases the plans allow (up to
// 500 MiB), so a bundle over STAGED_PUBLISH_THRESHOLD_BYTES goes in steps instead:
//
//   POST /v0/apps/:app_id/uploads (or POST /v0/uploads for a new app, in the selected account)
//     the PUT /v0/apps body, with each file as {path, content_type, size, sha256}; checked against the
//     plan's release limits first. 201: {upload_id, expires_at, needed, copied}. `copied` are files
//     Userland already has (the same size and SHA-256 in the live or a kept release): not sent again.
//   PUT /v0/uploads/:upload_id/files/<path>     each needed file's raw bytes, with x-userland-sha256
//   POST /v0/uploads/:upload_id/commit          with an Idempotency-Key; answers exactly as PUT /v0/apps
//
// A session lasts 24 hours (404 upload_not_found after that). Sending a file again is harmless, and
// committing again with the same key answers with the stored result, so the CLI retries both.

/** Bundles over this many bytes (the files' own sizes) go through an upload session. */
export const STAGED_PUBLISH_THRESHOLD_BYTES = 16 * 1024 * 1024;
/** Files sent at the same time. */
export const UPLOAD_CONCURRENCY = 4;
/** Tries for one file or the commit before giving up: rate limits, server errors and lost connections. */
export const UPLOAD_ATTEMPTS = 6;

export const OLD_API_MESSAGE =
  "This Userland API can't take a bundle over 16 MiB: it doesn't have upload sessions yet. Make the bundle smaller (leave out large files, or keep them in a file store and upload them from the app), or try again once the API has them.";
export const SESSION_EXPIRED_MESSAGE = "The upload session ended before the publish finished (sessions last 24 hours). Run the same publish again; nothing was published.";

export interface UploadFile {
  path: string;
  content_type: string;
  absolutePath: string;
  size: number;
}

export interface HashedUploadFile extends UploadFile {
  sha256: string;
}

export interface UploadSessionAnswer {
  upload_id: string;
  expires_at: string;
  needed: string[];
  copied: string[];
}

const READ_WITHOUT_FOLLOWING_LINKS = fsConstants.O_NOFOLLOW === undefined ? "r" : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

/** The total of the files' own sizes, which decides how the bundle is sent. */
export function bundleBytes(files: readonly Pick<UploadFile, "size">[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

/** A file's size and SHA-256 (hex), read as a stream, never following a symlink. */
export async function hashFile(absolutePath: string): Promise<{ size: number; sha256: string }> {
  const handle = await fs.open(absolutePath, READ_WITHOUT_FOLLOWING_LINKS);
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** Every file with its SHA-256, a few at a time. */
export async function hashFiles(files: readonly UploadFile[]): Promise<HashedUploadFile[]> {
  return await mapLimit(files, UPLOAD_CONCURRENCY, async (file) => {
    const { size, sha256 } = await hashFile(file.absolutePath);
    if (size !== file.size) {
      throw new Error(`Not publishing: ${file.path} changed while it was being read. Run the publish again.`);
    }
    return { ...file, sha256 };
  });
}

/**
 * Reads a file to send it, and checks it is still the one that was declared: the session checks the
 * bytes against the SHA-256 it was given, so a file changed since would be refused anyway.
 */
export async function readDeclaredFile(file: HashedUploadFile): Promise<Buffer> {
  const bytes = await fs.readFile(file.absolutePath, { flag: READ_WITHOUT_FOLLOWING_LINKS });
  if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new Error(`Not publishing: ${file.path} changed after the upload started. Run the publish again.`);
  }
  return bytes;
}

/** A release path in an upload address: each segment URL-encoded, the slashes kept. */
export function uploadFilePath(uploadId: string, filePath: string): string {
  return `/v0/uploads/${encodeURIComponent(uploadId)}/files/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

/** The session's answer, checked: the CLI only sends files it declared. */
export function checkedSession(answer: unknown, declared: ReadonlySet<string>): UploadSessionAnswer {
  const value = answer as Partial<UploadSessionAnswer> | null;
  if (!value || typeof value.upload_id !== "string" || value.upload_id === "" || !Array.isArray(value.needed) || !value.needed.every((item) => typeof item === "string")) {
    throw new Error("The API's answer to the upload session didn't name a session or the files it needs. Run the publish again.");
  }
  const unknown = value.needed.filter((item) => !declared.has(item));
  if (unknown.length > 0) {
    throw new Error(`The API asked for files this publish didn't declare (${unknown.slice(0, 3).join(", ")}). Run the publish again.`);
  }
  const copied = Array.isArray(value.copied) ? value.copied.filter((item): item is string => typeof item === "string") : [];
  return { upload_id: value.upload_id, expires_at: typeof value.expires_at === "string" ? value.expires_at : "", needed: value.needed, copied };
}

/** How long to wait before trying again: the server's Retry-After when it gave one, else 1, 2, 4... seconds up to 30. */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

/** Runs `work` on each item, at most `limit` at a time, keeping the items' order in the results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** "120.5 MiB": a bundle size for the progress line. */
export function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

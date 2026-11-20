import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { privateNativePathSegment } from "./nativePackage.js";
import type { NativeClient } from "./native.js";

const PART = 256 * 1024;
const versioned = (value: Uint8Array) => "sha256:v1:" + createHash("sha256").update(value).digest("hex");
interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
}
interface MissingFile extends FileEntry {
  missing_parts: [number, number][];
}
interface Receipt {
  operation_id: string;
  stage: string;
  missing: MissingFile[];
  next_cursor: string | null;
}

async function readPart(handle: FileHandle, offset: number, size: number): Promise<Buffer<ArrayBuffer>> {
  const bytes = Buffer.alloc(size);
  for (let n = 0; n < size;) {
    const { bytesRead } = await handle.read(bytes, n, size - n, offset + n);
    if (!bytesRead) throw new Error("A declared release file changed while being read.");
    n += bytesRead;
  }
  return bytes;
}

async function sendMissing(
  root: string,
  file: MissingFile,
  send: (part: number, bytes: Buffer<ArrayBuffer>, hash: string) => Promise<unknown>,
) {
  if (!Array.isArray(file.missing_parts) || file.missing_parts.length > 96) {
    throw new Error("Invalid release part ranges.");
  }
  if (!file.missing_parts.length) return;
  const filename = path.resolve(root, file.path);
  const regular = await fs.lstat(filename);
  if (
    !regular.isFile() || regular.isSymbolicLink() || await fs.realpath(filename) !== filename ||
    regular.size !== file.bytes
  ) {
    throw new Error(
      "The declared release file must be a regular file of the declared size inside the build directory: " +
        file.path,
    );
  }
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const held = await handle.stat();
    if (
      held.dev !== regular.dev || held.ino !== regular.ino || held.size !== file.bytes ||
      await fs.realpath(filename) !== filename
    ) {
      throw new Error("The release file changed while opening it: " + file.path);
    }
    // Verify before sending. Per-part hashes also catch a build rewriting this descriptor during the upload.
    const full = createHash("sha256"), hashes: string[] = [];
    for (let offset = 0; offset < file.bytes; offset += PART) {
      const bytes = await readPart(handle, offset, Math.min(PART, file.bytes - offset));
      full.update(bytes);
      hashes.push(versioned(bytes));
    }
    if ("sha256:v1:" + full.digest("hex") !== file.sha256) {
      throw new Error("Local file differs from the release manifest: " + file.path);
    }
    let previous = -1;
    for (const range of file.missing_parts) {
      if (!Array.isArray(range) || range.length !== 2) throw new Error("Invalid release part range.");
      const [first, last] = range;
      if (
        !Number.isInteger(first) || !Number.isInteger(last) || first <= previous || last < first ||
        last >= hashes.length
      ) {
        throw new Error("Invalid release part range.");
      }
      for (let i = first; i <= last; i++) {
        const bytes = await readPart(handle, i * PART, Math.min(PART, file.bytes - i * PART));
        if (versioned(bytes) !== hashes[i]) throw new Error("Release file changed during upload: " + file.path);
        await send(i, bytes, hashes[i]);
      }
      previous = last;
    }
  } finally {
    await handle.close();
  }
}

export async function transferPreparedRelease(
  client: NativeClient,
  body: string,
  directory: string,
  accountId: string,
  raw: boolean,
) {
  const root = await fs.realpath(directory);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("--release-root must be a build directory.");
  const entries: FileEntry[] = JSON.parse(body).source.release_manifest.files;
  if (entries.length > 1024) throw new Error("A release can contain up to 1,024 paths.");
  const allowed = new Map<string, FileEntry>();
  for (const file of entries) {
    if (
      !file || typeof file.path !== "string" || path.isAbsolute(file.path) ||
      /[\\\u0000-\u001f?#%]/u.test(file.path) ||
      file.path.split("/").some((segment) =>
        !segment || segment === "." || segment === ".." || privateNativePathSegment(segment)
      ) ||
      allowed.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
      file.bytes > 24 * 1024 * 1024 || !/^sha256:v1:[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw new Error("Invalid path, length or digest in the local release manifest.");
    }
    allowed.set(file.path, file);
  }
  const scope = { accountId, accountScoped: true, raw };
  let page = await client.apiFetch<Receipt>("/v1/apps/apply", { method: "POST", body }, scope);
  if (!/^relup_[A-Za-z0-9_-]+$/u.test(page.operation_id)) {
    throw new Error("The release service did not return a preparation ID.");
  }
  if (page.stage === "release_prepared") return page;
  const id = page.operation_id, segment = client.pathSegment(id, "operation ID"), processed = new Set<string>();
  const action = (transfer: Record<string, unknown>) =>
    client.apiFetch<Receipt>("/v1/apps/apply", {
      method: "POST",
      body: JSON.stringify({ account_id: accountId, operation_id: id, transfer }),
    }, scope);
  for (;;) {
    if (
      page.operation_id !== id || page.stage !== "awaiting_release_content" || !Array.isArray(page.missing) ||
      page.missing.length > 32
    ) {
      throw new Error("Unexpected release preparation status. Read the operation and retry the original intent.");
    }
    for (const f of page.missing) {
      const entry = allowed.get(f.path);
      if (!entry || entry.bytes !== f.bytes || entry.sha256 !== f.sha256 || processed.has(f.path)) {
        throw new Error("The service requested a file outside the submitted release manifest.");
      }
      await sendMissing(
        root,
        f,
        (part, bytes, hash) =>
          client.apiFetch(
            `/v1/operations/${segment}/source/parts/${part}?${new URLSearchParams({ path: f.path })}`,
            {
              method: "PUT",
              body: bytes,
              headers: { "content-type": "application/octet-stream", "x-userland-sha256": hash },
            },
            scope,
          ),
      );
      await action({ action: "verify", path: f.path });
      processed.add(f.path);
    }
    if (page.next_cursor === null) break;
    if (!page.missing.length || page.next_cursor !== page.missing.at(-1)?.path) {
      throw new Error("Invalid release status cursor.");
    }
    page = await action({ action: "status", after: page.next_cursor });
  }
  return action({ action: "commit" });
}

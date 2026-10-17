import { constants, promises as fs } from "node:fs";
import path from "node:path";

export const NATIVE_PACKAGE_MAX_BYTES = 512 * 1024;
export const NATIVE_PACKAGE_MAX_FILES = 128;
const EXCLUDED = new Set([".git", "node_modules", ".wrangler"]);
const PRIVATE_NAME = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.npmrc|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|\.(?:pem|key|p12|pfx)$/iu;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u;

/** Package a clean prebuilt folder without following links or leaking local credential files. */
export async function readNativePackage(directory: string): Promise<{ files: Record<string, string> }> {
  const chosen = path.resolve(directory), rootInfo = await fs.lstat(chosen);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Use a real prebuilt package directory, not a symlink.");
  const root = await fs.realpath(chosen), files: Record<string, string> = Object.create(null);
  const resolvedRoot = await fs.lstat(root), chosenAgain = await fs.lstat(chosen);
  if (chosenAgain.isSymbolicLink() || resolvedRoot.dev !== rootInfo.dev || resolvedRoot.ino !== rootInfo.ino || chosenAgain.dev !== rootInfo.dev || chosenAgain.ino !== rootInfo.ino) throw new Error("The package directory changed while being selected. Retry from a stable prebuilt folder.");
  let bytes = 0;
  async function walk(folder: string) {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (EXCLUDED.has(entry.name)) continue;
      const full = path.join(folder, entry.name), relative = path.relative(root, full).split(path.sep).join("/");
      if (relative.length > 200 || relative.split("/").some((segment) => !segment || segment === "." || segment === "..") || /[\\\u0000-\u001f?#%]/u.test(relative)) throw new Error(`Unsafe package path: ${relative}`);
      if (PRIVATE_NAME.test(entry.name) || entry.name === ".userland" || entry.name === "manifest.userland.json") throw new Error(`Do not include credentials, private keys or a legacy Userland manifest in a native package: ${relative}`);
      const info = await fs.lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Native packages cannot contain symlinks: ${relative}`);
      if (info.isDirectory()) { await walk(full); continue; }
      if (!info.isFile()) throw new Error(`Native packages contain only regular text files: ${relative}`);
      if (Object.keys(files).length >= NATIVE_PACKAGE_MAX_FILES) throw new Error(`Native packages are limited to ${NATIVE_PACKAGE_MAX_FILES} files.`);
      if (info.size > NATIVE_PACKAGE_MAX_BYTES - bytes) throw new Error("Native prebuilt source is limited to 512 KiB. Use a clean prebuilt folder; hosted builds are not available yet.");
      const before = await fs.realpath(full);
      if (!before.startsWith(root + path.sep)) throw new Error(`Package path escaped the selected folder: ${relative}`);
      const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`Package changed while reading: ${relative}. Retry from a stable prebuilt folder.`);
        const buffer = Buffer.alloc(Math.min(opened.size + 1, NATIVE_PACKAGE_MAX_BYTES - bytes + 1));
        let offset = 0;
        for (;;) {
          const read = await handle.read(buffer, offset, buffer.length - offset, offset);
          offset += read.bytesRead;
          if (!read.bytesRead || offset === buffer.length) break;
        }
        if (offset > NATIVE_PACKAGE_MAX_BYTES - bytes) throw new Error("Native prebuilt source is limited to 512 KiB.");
        if (offset > opened.size) throw new Error(`Package changed while reading: ${relative}. Retry from a stable prebuilt folder.`);
        const after = await fs.lstat(full), resolved = await fs.realpath(full);
        if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || resolved !== before) throw new Error(`Package changed while reading: ${relative}. Retry from a stable prebuilt folder.`);
        content = buffer.subarray(0, offset);
      } finally { await handle.close(); }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
      catch { throw new Error(`The current native prebuilt profile only supports UTF-8 files: ${relative}`); }
      if (text.includes("\0")) throw new Error(`The current native prebuilt profile only supports text files: ${relative}`);
      if (PRIVATE_KEY.test(text)) throw new Error(`Private key material cannot be included in an app package: ${relative}`);
      files[relative] = text; bytes += content.length;
    }
  }
  await walk(root);
  if (!Object.hasOwn(files, "wrangler.jsonc")) throw new Error("Include wrangler.jsonc in the prebuilt package. Native Workers use Cloudflare configuration directly.");
  if (Object.keys(files).length < 2) throw new Error("Include wrangler.jsonc and its prebuilt JavaScript module. Hosted builds are not available yet.");
  return { files };
}

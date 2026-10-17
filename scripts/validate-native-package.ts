import { readdir, readFile } from "node:fs/promises";
const expected=["accountMembership.js","index.js","native.js","nativeData.js","nativeDomains.js","nativePackage.js","nativeSecrets.js","nativeTransfer.js","terminal.js"];
const actual=(await readdir("cli/dist")).sort();
if(JSON.stringify(actual)!==JSON.stringify(expected.sort()))throw new Error(`Native CLI build contains unexpected/missing files: ${actual.join(", ")}`);
const entry=await readFile("cli/dist/index.js","utf8");
if(/from ["']\.\/(validation|appFiles|uploadSession)/u.test(entry))throw new Error("Native CLI still imports retired runtime support");
console.log(`Validated ${actual.length} native/platform CLI modules; no retired runtime schema or validation payload.`);

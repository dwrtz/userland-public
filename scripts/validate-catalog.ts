import {fileURLToPath} from "node:url";
import {validateNativeCatalog} from "./native-catalog.js";
const entries=await validateNativeCatalog(fileURLToPath(new URL("..",import.meta.url)));
console.log(`Validated ${entries.length} selected native examples.`);

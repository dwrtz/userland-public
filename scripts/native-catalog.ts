import {readFile,readdir} from "node:fs/promises";
import path from "node:path";
import {readNativePackage} from "../cli/src/nativePackage.js";
export interface NativeExample {slug:string;title:string;summary:string;path:string;capabilities:string[];difficulty:string;userland_api_version:"native-v1";launch_role:"native-reference"}
export function assertNativeExample(value:unknown):asserts value is NativeExample {
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Native example must be an object.");
 const v=value as Record<string,unknown>,fields=["slug","title","summary","path","capabilities","difficulty","userland_api_version","launch_role"];
 if(Object.keys(v).length!==fields.length||fields.some(k=>!Object.hasOwn(v,k)))throw new Error("Native example metadata must omit legacy plans, demos and runtime fields.");
 if(typeof v.slug!=="string"||!/^[a-z][a-z0-9-]*$/u.test(v.slug)||v.path!=="examples/"+v.slug)throw new Error("Invalid native example path.");
 if([v.title,v.summary].some(x=>typeof x!=="string"||!x))throw new Error("Native example needs a title and summary.");
 if(v.userland_api_version!=="native-v1"||v.launch_role!=="native-reference"||!["beginner","intermediate","advanced"].includes(String(v.difficulty)))throw new Error("Native example contract is invalid.");
 if(!Array.isArray(v.capabilities)||!v.capabilities.length||new Set(v.capabilities).size!==v.capabilities.length||v.capabilities.some(x=>!["worker","static","app_auth","d1","r2","secrets"].includes(String(x))))throw new Error("Unknown native example capability.");
}
export async function validateNativeCatalog(root:string):Promise<NativeExample[]> {
 const catalog=JSON.parse(await readFile(path.join(root,"catalog.json"),"utf8")) as {version?:unknown;userland_api_version?:unknown;examples?:unknown};
 if(catalog.version!==1||catalog.userland_api_version!=="native-v1"||!Array.isArray(catalog.examples)||!catalog.examples.length)throw new Error("Expected the selected native-v1 catalog.");
 const seen=new Set<string>(),entries:NativeExample[]=[];
 for(const value of catalog.examples){assertNativeExample(value);if(seen.has(value.slug))throw new Error("Duplicate native example.");seen.add(value.slug);entries.push(value);
  const folder=path.join(root,value.path),metadata=JSON.parse(await readFile(path.join(folder,"example.json"),"utf8"));if(JSON.stringify(metadata)!==JSON.stringify(value))throw new Error("Example metadata differs from catalog: "+value.slug);
  const pkg=await readNativePackage(folder),config=JSON.parse(pkg.files["wrangler.jsonc"]);
  if(typeof config.main!=="string"||!Object.hasOwn(pkg.files,config.main)||typeof config.compatibility_date!=="string")throw new Error("Native example entrypoint is incomplete.");
  if(Object.hasOwn(pkg.files,"manifest.userland.json")||Object.values(pkg.files).some(text=>/@userland\/(?:runtime|sdk)|ctx\.(?:data|auth|files|secrets)\b/u.test(text)))throw new Error("Native reference contains a retired runtime dependency.");
  for(const file of ["README.md","AGENT.md"])if(!Object.hasOwn(pkg.files,file))throw new Error("Missing native example guidance.");
 }
 for(const entry of await readdir(path.join(root,"examples"),{withFileTypes:true})){if(!entry.isDirectory())continue;try{await readFile(path.join(root,"examples",entry.name,"wrangler.jsonc"));if(!seen.has(entry.name))throw new Error("Unlisted native example: "+entry.name);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 return entries;
}

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNativeExample, validateNativeCatalog } from "./native-catalog.js";
const roots:string[]=[];
const entry={slug:"notes",title:"Notes",summary:"A normal Worker",path:"examples/notes",capabilities:["worker","static"],difficulty:"beginner",userland_api_version:"native-v1",launch_role:"native-reference"};
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),"native-catalog-"));roots.push(root);await mkdir(path.join(root,entry.path),{recursive:true});await writeFile(path.join(root,"catalog.json"),JSON.stringify({version:1,userland_api_version:"native-v1",examples:[entry]}));for(const [name,value] of Object.entries({"example.json":JSON.stringify(entry),"wrangler.jsonc":JSON.stringify({main:"worker.js",compatibility_date:"2026-05-01"}),"worker.js":"export default {fetch(){return new Response('ok')}}","README.md":"Native docs","AGENT.md":"Native instructions"}))await writeFile(path.join(root,entry.path,name),value);return root;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
describe("selected native example catalog",()=>{
 it("validates the exact directory package and matching metadata",async()=>{const root=await fixture();expect(await validateNativeCatalog(root)).toEqual([entry]);});
 it("rejects legacy runtime and plan claims in metadata",()=>{for(const changed of [{...entry,required_plan:"free"},{...entry,userland_api_version:"v0"},{...entry,capabilities:["data"]}])expect(()=>assertNativeExample(changed)).toThrow();});
 it("rejects metadata drift and missing Worker entrypoints",async()=>{const root=await fixture();await writeFile(path.join(root,entry.path,"example.json"),JSON.stringify({...entry,title:"Other"}));await expect(validateNativeCatalog(root)).rejects.toThrow("differs");await writeFile(path.join(root,entry.path,"example.json"),JSON.stringify(entry));await rm(path.join(root,entry.path,"worker.js"));await expect(validateNativeCatalog(root)).rejects.toThrow("entrypoint");});
 it("does not advertise a custom runtime dependency as a native reference",async()=>{const root=await fixture();await writeFile(path.join(root,entry.path,"worker.js"),"import helper from '@userland/runtime'");await expect(validateNativeCatalog(root)).rejects.toThrow("retired runtime");});
 it("rejects native folders missing from the selected catalog",async()=>{const root=await fixture();await mkdir(path.join(root,"examples/extra"));await writeFile(path.join(root,"examples/extra/wrangler.jsonc"),"{}");await expect(validateNativeCatalog(root)).rejects.toThrow("Unlisted");});
});

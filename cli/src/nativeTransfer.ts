import {createHash} from "node:crypto";
import type {NativeClient} from "./native.js";
import type {NativeLocalFile} from "./nativePackage.js";
const PART=256*1024;
const bytes=(value:NativeLocalFile)=>typeof value==="string"?Buffer.from(value,"utf8"):Buffer.from(value.base64,"base64");
const digest=(value:Uint8Array)=>"sha256:v1:"+createHash("sha256").update(value).digest("hex");
export function needsNativeTransfer(files:Record<string,NativeLocalFile>,encodedBytes:number){return encodedBytes>768*1024||Object.values(files).reduce((sum,value)=>sum+bytes(value).length,0)>512*1024;}

/** Transfer mechanics are automatic; every retry still belongs to one exact app operation. */
export async function transferNativePackage(client:NativeClient,intent:Record<string,unknown>,files:Record<string,NativeLocalFile>,accountId:string,raw:boolean){
  const source=intent.source as {format?:string};
  const manifest=Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([path,value])=>({path,bytes:bytes(value).length,sha256:digest(bytes(value)),encoding:typeof value==="string"?"utf8":"binary"}));
  const accepted=await client.apiFetch<Record<string,any>>("/v1/apps/apply",{method:"POST",body:JSON.stringify({...intent,source:{manifest,...(source.format?{format:source.format}:{})}})},{accountId,accountScoped:true,raw});
  if(!accepted.operation_id)throw new Error("The source transfer did not return an operation ID.");
  if(["committed","cleaned"].includes(accepted.source_transfer?.state))return accepted;
  if(accepted.status==="cancelled"||accepted.status==="failed")throw new Error(`Source transfer ${accepted.operation_id} ended. Read its status and start a new intent with the current app revision.`);
  const id=client.pathSegment(accepted.operation_id,"operation ID"),known=accepted.source_transfer?.parts??[];
  for(const [path,value] of Object.entries(files).sort(([a],[b])=>a.localeCompare(b))){const file=bytes(value);for(let part=0,offset=0;offset<file.length;part++,offset+=PART){
    if(known.some((entry:any)=>entry.path===path&&entry.part===part&&entry.state==="uploaded"))continue;
    const body=file.subarray(offset,offset+PART),query=new URLSearchParams({path});
    await client.apiFetch(`/v1/operations/${id}/source/parts/${part}?${query}`,{method:"PUT",headers:{"content-type":"application/octet-stream","x-userland-sha256":digest(body)},body},{accountId,accountScoped:true,raw});
  }}
  return client.apiFetch(`/v1/operations/${id}/source/commit`,{method:"POST",body:"{}"},{accountId,accountScoped:true,raw});
}

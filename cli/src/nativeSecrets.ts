import type { NativeClient } from "./native.js";
/** Native secret administration accepts only nonsecret intent, including from a terminal. */
export async function nativeSecretsCommand(args:string[],client:NativeClient):Promise<void>{
  const [action,app,name,...rest]=args;
  if(!["set","delete"].includes(action)||!app||!name)throw new Error("Use apps secrets set|delete <app-id> <NAME> with explicit native environment.");
  const allowed=["account","environment","expected-revision","expected-epoch","expected-secret-revision","idempotency-key","source-json","operation"],values:Record<string,string>={};let json=false;
  for(let i=0;i<rest.length;i++){const token=rest[i];if(token==="--json"){json=true;continue;}if(!token.startsWith("--")||!allowed.includes(token.slice(2))||!rest[i+1]||rest[i+1].startsWith("--"))throw new Error(`Unknown or incomplete native secret option ${token}. Values must be entered on the protected Userland page.`);values[token.slice(2)]=rest[++i];}
  if(!values.account||!["production","preview"].includes(values.environment))throw new Error("Choose --account and --environment production|preview explicitly.");
  const body:Record<string,unknown>={account_id:values.account,environment:values.environment};
  let path:string,method:"POST"|"PUT"|"DELETE";
  if(values.operation){if(action!=="set"||["source-json","expected-revision","expected-epoch","expected-secret-revision","idempotency-key"].some(key=>values[key]))throw new Error("--operation opens an existing external requirement; omit new-change fields.");path=`/v1/operations/${client.pathSegment(values.operation,"operation ID")}/secret-entries`;method="POST";body.name=name;}
  else{
    for(const key of ["expected-revision","expected-epoch","expected-secret-revision"]){if(key==="expected-secret-revision"&&values[key]==="none"){body.expected_secret_revision=null;continue;}if(!/^[1-9]\d*$/u.test(values[key]??"")||!Number.isSafeInteger(Number(values[key])))throw new Error(`--${key} must be exact current state; only an absent secret uses none.`);body[key.replaceAll("-","_")]=Number(values[key]);}
    if(!values["idempotency-key"]||values["idempotency-key"].length>128)throw new Error("Use a stable --idempotency-key for this exact credential change.");body.idempotency_key=values["idempotency-key"];
    if(action==="set"){
      let source:Record<string,unknown>;try{source=JSON.parse(values["source-json"]??"");}catch{throw new Error("--source-json must select generated, protected_entry, or scoped copy intent.");}
      const keys=source?.kind==="generated"?["kind","bytes"]:source?.kind==="protected_entry"?["kind","provider","purpose"]:source?.kind==="copy"?["kind","app_id","environment","name","revision"]:[];
      if(!keys.length||Object.keys(source).some(key=>!keys.includes(key)))throw new Error("Secret values are never accepted here. Select nonsecret generated, protected_entry, or scoped copy intent.");body.source=source;
    }else if(values["source-json"])throw new Error("Deleting a secret cannot supply new material.");
    path=`/v1/apps/${client.pathSegment(app,"app ID")}/secrets/${client.pathSegment(name,"secret name")}`;method=action==="set"?"PUT":"DELETE";
  }
  const result=await client.apiFetch(path,{method,body:JSON.stringify(body)},{accountId:values.account,accountScoped:true,raw:json});client.print(JSON.stringify(result,null,2));
}

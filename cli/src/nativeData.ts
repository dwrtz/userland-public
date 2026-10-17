import type {NativeClient} from "./native.js";
/** Data administration shares the native operation protocol; it never downloads a full archive. */
export async function nativeDataCommand(command:string,args:string[],client:NativeClient):Promise<void>{
  const action=args[0],query=command==="resources"&&action==="query",restore=command==="apps"&&action==="restore";
  if(!query&&!restore)throw new Error("Use resources query or apps restore.");
  const values:Record<string,string>={},positionals:string[]=[];let json=false;
  const allowed=["account","expected-revision","expected-epoch","idempotency-key","environment",...(query?["resource","statements-json"]:["recovery"])];
  for(let index=1;index<args.length;index++){const item=args[index];if(item==="--json"){json=true;continue;}if(item.startsWith("--")){const name=item.slice(2),value=args[++index];if(!allowed.includes(name)||!value||value.startsWith("--")||values[name]!==undefined)throw new Error(`Invalid or duplicate ${item}.`);values[name]=value;}else positionals.push(item);}
  if(positionals.length!==1)throw new Error("Pass one exact target app ID.");
  for(const name of allowed)if(!values[name]&&(query||name!=="environment"))throw new Error(`--${name} is required.`);
  if(values.environment&&!['production','preview'].includes(values.environment))throw new Error("--environment must be production or preview.");
  for(const name of ["expected-revision","expected-epoch"])if(!/^[1-9]\d*$/u.test(values[name])||!Number.isSafeInteger(Number(values[name])))throw new Error(`--${name} must be the exact current positive integer.`);
  if(values["idempotency-key"].length>128)throw new Error("--idempotency-key is at most 128 characters; reuse it only for this intent.");
  const body:Record<string,unknown>={account_id:values.account,expected_revision:Number(values["expected-revision"]),expected_epoch:Number(values["expected-epoch"]),idempotency_key:values["idempotency-key"]};
  if(query){
    if(!["production","preview"].includes(values.environment))throw new Error("--environment must be production or preview.");
    let statements:unknown;try{statements=JSON.parse(values["statements-json"]);}catch{throw new Error("--statements-json must be a JSON array.");}
    if(!Array.isArray(statements)||!statements.length||statements.length>16||Buffer.byteLength(JSON.stringify(statements))>65536||statements.some(item=>!item||typeof item!=="object"||typeof item.sql!=="string"||!item.sql.trim()||Object.keys(item).some(key=>!["sql","params"].includes(key))||item.params!==undefined&&(!Array.isArray(item.params)||item.params.length>100||item.params.some((value:unknown)=>value!==null&&typeof value!=="string"&&(typeof value!=="number"||!Number.isFinite(value))))))throw new Error("Use one to sixteen bounded SQL/params objects.");
    Object.assign(body,{resource_id:values.resource,environment:values.environment,statements});
  }else Object.assign(body,{recovery_id:values.recovery,environment:values.environment??"preview"});
  const path=`/v1/apps/${client.pathSegment(positionals[0],"app ID")}/${query?"resources/query":"restore"}`;
  client.print(JSON.stringify(await client.apiFetch(path,{method:"POST",body:JSON.stringify(body)},{accountId:values.account,accountScoped:true,raw:json}),null,2));
}

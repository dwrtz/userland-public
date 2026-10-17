import type { NativeClient } from "./native.js";

/** Domain propagation is polled through the ordinary operation API, never a CLI retry loop. */
export async function nativeDomainsCommand(args:string[],client:NativeClient):Promise<void>{
  const action=args[0];if(action!=="set"&&action!=="remove")throw new Error("Use routes set or routes remove.");
  const flags:Record<string,string>={},positionals:string[]=[];let json=false;
  const allowed=["account","hostname","environment","expected-epoch","idempotency-key",...(action==="set"?["cookie-policy"]:[])];
  for(let i=1;i<args.length;i++){const item=args[i];if(item==="--json"){json=true;continue;}if(item.startsWith("--")){const name=item.slice(2),value=args[++i];if(!allowed.includes(name)||!value||value.startsWith("--")||flags[name]!==undefined)throw new Error(`Invalid or duplicate ${item}.`);flags[name]=value;}else positionals.push(item);}
  if(positionals.length!==1)throw new Error("Pass one exact app ID.");
  for(const name of ["account","hostname","environment","expected-epoch","idempotency-key"])if(!flags[name])throw new Error(`--${name} is required.`);
  if(flags.environment!=="production")throw new Error("Custom domains currently attach to production; use the generated preview address.");
  if(!/^[1-9]\d*$/u.test(flags["expected-epoch"])||!Number.isSafeInteger(Number(flags["expected-epoch"])))throw new Error("--expected-epoch must be the current positive integer.");
  if(flags["idempotency-key"].length>128)throw new Error("--idempotency-key must be at most 128 characters.");
  if(flags["cookie-policy"]&&!['host','owned_site'].includes(flags["cookie-policy"]))throw new Error("--cookie-policy must be host or owned_site.");
  const body={hostname:flags.hostname,environment:flags.environment,expected_epoch:Number(flags["expected-epoch"]),idempotency_key:flags["idempotency-key"],...(flags["cookie-policy"]?{cookie_policy:flags["cookie-policy"]}:{})};
  const answer=await client.apiFetch(`/v1/apps/${client.pathSegment(positionals[0],"app ID")}/routes`,{method:action==="set"?"POST":"DELETE",body:JSON.stringify(body)},{accountId:flags.account,accountScoped:true,raw:json});
  client.print(JSON.stringify(answer,null,2));
}

import { describe, expect, it, vi } from "vitest";
import type { NativeClient } from "./native.js";
import { nativeSecretsCommand } from "./nativeSecrets.js";
function client(){return {apiFetch:vi.fn(async()=>({operation_id:"op_secret",status:"waiting"})) as unknown as NativeClient["apiFetch"],pathSegment:(value:string)=>encodeURIComponent(value),print:vi.fn()};}
describe("native secret intent",()=>{
  it("sends generation metadata and exact revisions, never a terminal secret value",async()=>{
    const c=client();await nativeSecretsCommand(["set","app_one","TOKEN","--account","acct_one","--environment","preview","--expected-revision","2","--expected-epoch","1","--expected-secret-revision","1","--idempotency-key","rotation-one","--source-json",'{"kind":"generated","bytes":32}'],c);
    expect(c.apiFetch).toHaveBeenCalledWith("/v1/apps/app_one/secrets/TOKEN",{method:"PUT",body:JSON.stringify({account_id:"acct_one",environment:"preview",expected_revision:2,expected_epoch:1,expected_secret_revision:1,idempotency_key:"rotation-one",source:{kind:"generated",bytes:32}})},{accountId:"acct_one",accountScoped:true,raw:false});
  });
  it("opens an existing requirement without making a new publication intent",async()=>{
    const c=client();await nativeSecretsCommand(["set","app_one","TOKEN","--account","acct_one","--environment","production","--operation","op_wait"],c);
    expect(c.apiFetch).toHaveBeenCalledWith("/v1/operations/op_wait/secret-entries",{method:"POST",body:JSON.stringify({account_id:"acct_one",environment:"production",name:"TOKEN"})},expect.anything());
  });
  it("rejects plaintext fields before making any request",async()=>{
    const c=client();await expect(nativeSecretsCommand(["set","app_one","TOKEN","--account","acct_one","--environment","preview","--value","secret"],c)).rejects.toThrow(/protected/);expect(c.apiFetch).not.toHaveBeenCalled();
  });
});

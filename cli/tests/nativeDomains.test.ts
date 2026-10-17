import { describe,expect,it } from "vitest";
import { nativeDomainsCommand } from "../src/nativeDomains";
import type { NativeClient } from "../src/native";
function client(){const calls:unknown[][]=[],context:NativeClient={apiFetch:async<T>(...args:unknown[])=>{calls.push(args);return {operation_id:"domop_one"} as T;},pathSegment:encodeURIComponent,print:()=>{}};return {calls,context};}
const flags=["app_one","--account","acct_one","--hostname","app.customer.com","--environment","production","--expected-epoch","2","--idempotency-key","once"];
describe("native domain CLI",()=>{
  it("uses the authenticated native route endpoint without a propagation retry loop",async()=>{const {calls,context}=client();await nativeDomainsCommand(["set",...flags,"--cookie-policy","owned_site","--json"],context);expect(calls).toHaveLength(1);expect(calls[0][0]).toBe("/v1/apps/app_one/routes");expect(calls[0][1]).toMatchObject({method:"POST"});expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({hostname:"app.customer.com",environment:"production",expected_epoch:2,idempotency_key:"once",cookie_policy:"owned_site"});expect(calls[0][2]).toMatchObject({accountId:"acct_one",accountScoped:true});});
  it("removes only the explicit custom hostname",async()=>{const {calls,context}=client();await nativeDomainsCommand(["remove",...flags],context);expect(calls[0][1]).toMatchObject({method:"DELETE"});});
  it.each([["--environment","preview"],["--expected-epoch","0"],["--hostname","duplicate"],["--cookie-policy","arbitrary"]])("rejects ambiguous or unsupported flags %j",async(extra)=>{const {calls,context}=client();await expect(nativeDomainsCommand(["set",...flags,...extra],context)).rejects.toThrow();expect(calls).toHaveLength(0);});
});

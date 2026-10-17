import {describe,expect,it,vi} from "vitest";
import {nativeSecretsCommand} from "../src/nativeSecrets.js";
const client=()=>({apiFetch:vi.fn(async()=>({secrets:[]})),pathSegment:encodeURIComponent,print:vi.fn()});
describe("native secret metadata",()=>{
 it("lists only the selected owned environment using the native app view",async()=>{const c=client();await nativeSecretsCommand(["list","app_one","--account","acct_one","--environment","preview","--json"],c);expect(c.apiFetch).toHaveBeenCalledWith("/v1/apps/app_one?view=secrets&environment=preview",{method:"GET"},{accountId:"acct_one",accountScoped:true,raw:true});});
 it("does not accept a secret value or an unknown list argument",async()=>{const c=client();await expect(nativeSecretsCommand(["list","app_one","--value","no"],c)).rejects.toThrow();expect(c.apiFetch).not.toHaveBeenCalled();});
});

import { describe, expect, it, vi } from "vitest";
import type { NativeClient } from "../src/native.js";
import { nativeRecoveryCommand } from "../src/nativeRecovery.js";

const result = { recovery_id: "recovery_one", status: "waiting", resources: [{ source_resource_id: "nres_one", state: "reserved" }] };
const client = () => ({
  apiFetch: vi.fn(async (_path: string, _init: RequestInit, _options?: unknown) => result),
  pathSegment: (value: string) => encodeURIComponent(value),
  print: vi.fn()
});
const intent = ["snapshot", "app_one", "--account", "acct_one", "--environment", "production", "--resources-json", '["nres_one","nres_two"]', "--expected-revision", "2", "--expected-epoch", "3", "--idempotency-key", "before-change"];

describe("native snapshot administration", () => {
  it("creates only the explicitly selected snapshot and preserves the retry identity and metadata", async () => {
    const c = client();
    await nativeRecoveryCommand("apps", [...intent, "--json"], c as unknown as NativeClient);
    await nativeRecoveryCommand("apps", [...intent, "--json"], c as unknown as NativeClient);
    expect(c.apiFetch).toHaveBeenCalledTimes(2);
    for (const call of c.apiFetch.mock.calls) expect(call).toEqual([
      "/v1/apps/app_one/recoveries",
      { method: "POST", body: JSON.stringify({ account_id: "acct_one", environment: "production", resource_ids: ["nres_one", "nres_two"], expected_revision: 2, expected_epoch: 3, idempotency_key: "before-change" }) },
      { accountId: "acct_one", accountScoped: true, raw: true }
    ]);
    expect(c.print).toHaveBeenLastCalledWith(JSON.stringify(result, null, 2));
  });

  it.each([
    ["list", "app_one", "/v1/apps/app_one/recoveries", "GET"],
    ["get", "recovery_one", "/v1/recoveries/recovery_one", "GET"],
    ["resume", "recovery_one", "/v1/recoveries/recovery_one/resume", "POST"],
    ["cancel", "recovery_one", "/v1/recoveries/recovery_one/cancel", "POST"]
  ])("%s uses one metadata request without archive retrieval", async (action, id, route, method) => {
    const c = client();
    await nativeRecoveryCommand("recoveries", [action, id, "--account", "acct_one"], c as unknown as NativeClient);
    expect(c.apiFetch).toHaveBeenCalledExactlyOnceWith(route, { method }, { accountId: "acct_one", accountScoped: true, raw: false });
    expect(c.print).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result, null, 2));
  });

  it.each(["account", "environment", "resources-json", "expected-revision", "expected-epoch", "idempotency-key"])("requires explicit --%s before creating a snapshot", async flag => {
    const c = client(), args = [...intent], index = args.indexOf(`--${flag}`);
    args.splice(index, 2);
    await expect(nativeRecoveryCommand("apps", args, c as unknown as NativeClient)).rejects.toThrow(`--${flag} is required`);
    expect(c.apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["resources-json", "{}"], ["resources-json", "not-json"], ["resources-json", "[]"],
    ["resources-json", '["one","one"]'], ["resources-json", '["one","two","three","four","five"]'],
    ["resources-json", '["one",2]'], ["resources-json", '[" "]'], ["resources-json", JSON.stringify(["x".repeat(129)])],
    ["environment", "latest"], ["expected-revision", "0"], ["expected-epoch", "1.5"],
    ["expected-revision", "9007199254740992"], ["idempotency-key", "x".repeat(129)]
  ])("rejects invalid %s=%s without requesting a snapshot", async (flag, value) => {
    const c = client(), args = [...intent];
    args[args.indexOf(`--${flag}`) + 1] = value;
    await expect(nativeRecoveryCommand("apps", args, c as unknown as NativeClient)).rejects.toThrow();
    expect(c.apiFetch).not.toHaveBeenCalled();
  });

  it("refuses archive/download flags, duplicate scope and missing recovery scope", async () => {
    const c = client();
    for (const [command, args] of [
      ["apps", [...intent, "--output", "archive.zip"]],
      ["apps", [...intent, "--account", "acct_other"]],
      ["recoveries", ["download", "recovery_one", "--account", "acct_one"]],
      ["recoveries", ["get", "recovery_one", "--account", "acct_one", "--download"]],
      ["recoveries", ["cancel", "recovery_one"]]
    ] as const) await expect(nativeRecoveryCommand(command, [...args], c as unknown as NativeClient)).rejects.toThrow();
    expect(c.apiFetch).not.toHaveBeenCalled();
  });

  it("preserves an API refusal and never falls back to another operation", async () => {
    const c = client(), refusal = new Error("recovery_authority_revoked");
    c.apiFetch.mockRejectedValueOnce(refusal);
    await expect(nativeRecoveryCommand("recoveries", ["resume", "recovery_one", "--account", "acct_one"], c as unknown as NativeClient)).rejects.toBe(refusal);
    expect(c.apiFetch).toHaveBeenCalledTimes(1);
    expect(c.print).not.toHaveBeenCalled();
  });
});

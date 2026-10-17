import { describe, expect, it, vi } from "vitest";
import { accountMembershipCommand, type MembershipClient } from "../src/accountMembership";

function client() {
  const calls: Array<{ apiPath: string; init: RequestInit; options: unknown }> = [];
  const lines: string[] = [];
  const context: MembershipClient = {
    apiFetch: async <T>(apiPath: string, init: RequestInit, options: unknown) => {
      calls.push({ apiPath, init, options });
      return { account_id: "acct_team", members: [], invitations: [], member_capacity: 3, invitation: { id: "acinv_1", expires_at: "2026-10-24T12:00:00.000Z" }, notification_status: "sent" } as T;
    },
    resolveAccountId: vi.fn(async (explicit) => explicit ?? "acct_team"),
    pathSegment: (value) => { if (!value || /[/?#\\]/u.test(value)) throw new Error("Invalid path segment"); return encodeURIComponent(value); },
    prompt: vi.fn(async () => "yes"), interactive: false, print: (line) => lines.push(line)
  };
  return { context, calls, lines };
}

describe("Account membership CLI commands", () => {
  it.each([
    [["members", "list"], "GET", "/v0/accounts/acct_team/members", undefined],
    [["members", "invite", "member@example.com", "--role", "member"], "POST", "/v0/accounts/acct_team/invitations", { email: "member@example.com", role: "member" }],
    [["members", "role", "usr_member", "--role", "viewer", "--account", "acct_other"], "PATCH", "/v0/accounts/acct_other/members/usr_member", { role: "viewer" }],
    [["members", "remove", "usr_member", "--yes"], "DELETE", "/v0/accounts/acct_team/members/usr_member", undefined],
    [["invitations", "list"], "GET", "/v0/account-invitations", undefined],
    [["invitations", "accept", "acinv_1"], "POST", "/v0/account-invitations/acinv_1/accept", undefined],
    [["invitations", "revoke", "acinv_1", "--yes"], "DELETE", "/v0/accounts/acct_team/invitations/acinv_1", undefined]
  ] as const)("maps %j to the same supported administration API", async (args, method, apiPath, body) => {
    const { context, calls } = client();
    await accountMembershipCommand([...args], context);
    expect(calls).toHaveLength(1);
    expect(calls[0].apiPath).toBe(apiPath);
    expect(calls[0].init.method).toBe(method);
    expect(calls[0].init.body ? JSON.parse(String(calls[0].init.body)) : undefined).toEqual(body);
  });
  it("fails closed if the API cannot resolve an Account instead of calling an unscoped path", async () => {
    const { context, calls } = client();
    context.resolveAccountId = async () => undefined as unknown as string;
    await expect(accountMembershipCommand(["members", "list"], context)).rejects.toThrow("No Account was selected");
    expect(calls).toEqual([]);
  });
  it("requires --yes in a noninteractive client before removing or revoking anything", async () => {
    const { context, calls } = client();
    for (const args of [["members", "remove", "usr_member"], ["invitations", "revoke", "acinv_1"]]) {
      await expect(accountMembershipCommand(args, context)).rejects.toThrow("Pass --yes");
    }
    expect(calls).toEqual([]);
  });
  it("names the selected Account in an interactive prompt and never mutates after refusal", async () => {
    const { context, calls, lines } = client();
    context.interactive = true;
    context.prompt = vi.fn(async () => "no");
    await accountMembershipCommand(["members", "remove", "usr_member"], context);
    expect(calls).toEqual([]);
    expect(context.resolveAccountId).toHaveBeenCalledOnce();
    expect(context.prompt).toHaveBeenCalledWith(expect.stringContaining("in Account acct_team"));
    expect(lines).toEqual(["membership_change=cancelled"]);
  });
  it("rejects owner elevation, invalid paths and unexpected flags before contacting the API", async () => {
    const { context, calls } = client();
    for (const args of [["members", "invite", "member@example.com", "--role", "owner"], ["members", "role", "usr_bad/path", "--role", "viewer"], ["invitations", "accept", "acinv_1", "--account", "acct_other"], ["members", "list", "--role", "admin"]]) {
      await expect(accountMembershipCommand(args, context)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
  it("does not use a selected Account for the person's invitation inbox or acceptance", async () => {
    const { context, calls } = client();
    await accountMembershipCommand(["invitations", "accept", "acinv_1"], context);
    expect(context.resolveAccountId).not.toHaveBeenCalled();
    expect(calls[0].options).toEqual({ accountId: undefined, accountScoped: false, raw: false });
  });
  it("returns structured JSON for automation and treats email delivery status honestly", async () => {
    const { context, lines } = client();
    await accountMembershipCommand(["members", "invite", "member@example.com", "--role", "viewer", "--json"], context);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ invitation: { id: "acinv_1" }, notification_status: "sent" });
  });
});

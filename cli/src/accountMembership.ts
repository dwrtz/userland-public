import { terminalSafe } from "./terminal.js";

export interface MembershipClient {
  apiFetch<T>(apiPath: string, init: RequestInit, options?: { accountId?: string; accountScoped?: boolean; raw?: boolean }): Promise<T>;
  resolveAccountId(explicit: string | undefined): Promise<string>;
  pathSegment(value: string, description: string): string;
  prompt(question: string): Promise<string>;
  interactive: boolean;
  print(line: string): void;
}
interface Options { account?: string; role?: string; json?: boolean; yes?: boolean; positional: string[] }

/** Account administration stays separate from Customer App visitor invitations. */
export async function accountMembershipCommand(args: string[], client: MembershipClient): Promise<void> {
  const [group, action, ...rest] = args;
  const accountScoped = group === "members" || (group === "invitations" && action === "revoke");
  const changesRole = group === "members" && (action === "invite" || action === "role");
  const destructive = (group === "members" && action === "remove") || (group === "invitations" && action === "revoke");
  const known = group === "members" ? ["list", "invite", "role", "remove"].includes(action) : group === "invitations" && ["list", "accept", "revoke"].includes(action);
  if (!known) throw new Error("Use accounts members list|invite|role|remove, or accounts invitations list|accept|revoke. See userland --help.");
  const options = parseOptions(rest, { accountScoped, changesRole, destructive });
  const value = options.positional[0];
  if ((action === "list" && options.positional.length !== 0) || (action !== "list" && (options.positional.length !== 1 || !value))) throw new Error(`accounts ${group} ${action} ${action === "list" ? "takes no positional arguments" : "requires exactly one email, User ID or invitation ID"}.`);
  if (changesRole && !["admin", "member", "viewer"].includes(options.role ?? "")) throw new Error("--role must be admin, member or viewer. Ownership cannot be transferred through member administration.");
  if (group === "members" && action === "invite" && (!value.includes("@") || /[\s\u0000-\u001f]/u.test(value) || value.length > 254)) throw new Error("Enter a valid platform sign-in email address.");
  const segment = action !== "list" && action !== "invite" ? client.pathSegment(value, group === "members" ? "User ID" : "invitation ID") : "";
  if (destructive && !options.yes && !client.interactive) throw new Error("Pass --yes to remove an Account member or revoke an invitation non-interactively.");
  const accountId = accountScoped ? await client.resolveAccountId(options.account) : undefined;
  if (accountScoped && (typeof accountId !== "string" || !accountId)) throw new Error("No Account was selected or returned by the API. Use accounts list and pass --account.");
  const accountPath = accountId ? `/v0/accounts/${client.pathSegment(accountId, "Account ID")}` : "";
  if (destructive && !options.yes) {
    const answer = await client.prompt(`${action === "remove" ? "Remove Account access for" : "Revoke Account invitation"} ${terminalSafe(value)} in Account ${terminalSafe(accountId ?? "")}? Type yes to continue: `);
    if (answer.toLowerCase() !== "yes") { client.print("membership_change=cancelled"); return; }
  }
  let apiPath: string;
  let method: "GET" | "POST" | "PATCH" | "DELETE";
  let body: Record<string, string> | undefined;
  if (group === "members") {
    if (action === "list") { apiPath = `${accountPath}/members`; method = "GET"; }
    else if (action === "invite") { apiPath = `${accountPath}/invitations`; method = "POST"; body = { email: value, role: options.role! }; }
    else { apiPath = `${accountPath}/members/${segment}`; method = action === "remove" ? "DELETE" : "PATCH"; if (method === "PATCH") body = { role: options.role! }; }
  } else if (action === "revoke") { apiPath = `${accountPath}/invitations/${segment}`; method = "DELETE"; }
  else { apiPath = action === "list" ? "/v0/account-invitations" : `/v0/account-invitations/${segment}/accept`; method = action === "list" ? "GET" : "POST"; }
  const result = await client.apiFetch<Record<string, unknown>>(apiPath, { method, ...(body ? { body: JSON.stringify(body) } : {}) }, { accountId, accountScoped, raw: options.json === true });
  if (options.json) { client.print(JSON.stringify(result, null, 2)); return; }
  if (group === "members" && action === "list") {
    client.print(`account_id=${terminalSafe(String(result.account_id ?? accountId))}`);
    for (const row of rows(result.members)) client.print([row.user_id, row.role, row.username, row.email ?? ""].map((field) => terminalSafe(String(field ?? ""))).join("\t"));
    for (const row of rows(result.invitations)) client.print(["invitation", row.id, row.email_normalized, row.role, row.expires_at].map((field) => terminalSafe(String(field ?? ""))).join("\t"));
    client.print(`member_capacity=${result.member_capacity === null ? "unlimited" : terminalSafe(String(result.member_capacity ?? "unknown"))}`);
    return;
  }
  if (group === "invitations" && action === "list") {
    for (const row of rows(result.invitations)) client.print([row.id, row.account_id, row.account_name, row.role, row.expires_at].map((field) => terminalSafe(String(field ?? ""))).join("\t"));
    return;
  }
  if (action === "invite") {
    const invitation = result.invitation as Record<string, unknown> | undefined;
    client.print(`invitation_id=${terminalSafe(String(invitation?.id ?? ""))}`);
    client.print(`expires_at=${terminalSafe(String(invitation?.expires_at ?? ""))}`);
    client.print(`notification_status=${terminalSafe(String(result.notification_status ?? "unknown"))}`);
    client.print("The recipient must sign in with that email address and accept in Members. The invitation ID alone grants no access.");
    return;
  }
  client.print(action === "accept" ? `Joined Account ${terminalSafe(String(result.account_id ?? ""))}. Select it with userland accounts use <account-id>.` : action === "remove" ? "Account member removed." : action === "revoke" ? "Account invitation revoked." : "Account member role changed.");
}

function rows(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : []; }
function parseOptions(args: string[], allowed: { accountScoped: boolean; changesRole: boolean; destructive: boolean }): Options {
  const options: Options = { positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--json") { options.json = true; continue; }
    if ((item === "--yes" || item === "-y") && allowed.destructive) { options.yes = true; continue; }
    if ((item === "--account" && allowed.accountScoped) || (item === "--role" && allowed.changesRole)) {
      const next = args[++index];
      if (!next || next.startsWith("-")) throw new Error(`${item} requires a value.`);
      if (item === "--account") options.account = next; else options.role = next;
      continue;
    }
    if (item.startsWith("-")) throw new Error(`Unknown option ${item}. See userland --help.`);
    options.positional.push(item);
  }
  return options;
}

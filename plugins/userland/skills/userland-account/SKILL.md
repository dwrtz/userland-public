---
name: userland-account
description: Use when the owner asks to sign in or out of Userland, choose which business to work in, check their plan, limits or what a smaller plan would turn off, make, rename or revoke API keys, or contact Userland support.
---

# Userland account

Userland API version: v0

Use this skill for the owner's Userland account rather than one app: signing in and out, the businesses they belong to, their plan and limits, API keys, and support requests.

## Connector or CLI

There are two ways into Userland. Both run the same operations, with the same permissions, checks, errors and plan limits. Find out which one you have before you start, and use it for the whole task.

- **The Userland connector.** Userland's tools, such as `auth_status` and `apps_publish`, are in your tool list: in ChatGPT or Claude with Userland added, or in a coding agent with the Userland plugin. Use the "Connector tool" column below. Don't switch to a terminal for any step, and don't ask the owner to install anything.
- **The Userland CLI.** There are no Userland tools, and you can run commands in a terminal. Use the "CLI command" column below. The CLI needs Node.js 20 or newer: `npm install -g @userland.fun/cli`.
- **Neither.** Tell the owner how to add Userland to their assistant: https://docs.userland.fun/guides/chat-assistants/.

When a tool or a command fails, tell the owner what its error says and follow its next steps. Don't retry the step the other way. Secret values and API keys never go in the chat: the connector gives the owner a Userland page to type a secret on, and the CLI reads one from stdin.

## Inputs

- What the owner wants to do with their account.
- The business, when they have more than one.

## Outputs

- Who is signed in, which business is selected, and its plan, limits and usage.
- The result of the change: a key made, renamed or revoked, a business selected, a sign-out, or a support request sent.

## Steps

1. Check who is signed in and which business is selected (`auth_status`, or `userland auth status`).
2. To sign in:
   - With the connector, connecting is the sign-in: the owner approved Userland in their browser when they added it. If the connection has ended, they connect again in their assistant's settings.
   - With the CLI, run `userland login`. It opens the browser, the owner signs in or signs up and approves there, and the CLI saves a new API key. Never ask for a password.
3. When the owner has more than one business, list them and select the one to work in. With the connector the choice is kept for this connection; with the CLI it's saved for later commands.
4. For plan questions, read the business's status (plan and billing) and limits (each limit and its usage). Before the owner moves to a smaller plan, show what would stop working.
5. API keys are for coding agents and scripts. List them, make one, rename one, or revoke one the owner names. With the connector, a new key is shown once on a single-use Userland page, never in the chat; keys made this way keep working after the connection ends, until the owner revokes them. With the CLI, the new key is printed once in the terminal.
6. To sign out: with the CLI, `userland auth logout` forgets the saved key, and `--revoke` also revokes it. With the connector, `auth_logout` with `revoke` ends this assistant's connection. The owner can also disconnect assistants on the console's Chat assistants page.
7. For help from Userland, open a support request with a clear subject, what happened, and the app id when it's about one app.

## Commands

| What to do | Connector tool | CLI command |
| --- | --- | --- |
| Sign in or sign up | Connecting is the sign-in: the owner approves Userland in their browser | `userland login` |
| Save a key the owner already has (read from stdin or a hidden prompt) | Not needed: connecting is the sign-in | `userland auth save-key` |
| See who is signed in, and to which business | `auth_status` | `userland auth status` |
| Sign out | `auth_logout` | `userland auth logout` |
| Sign out, and revoke the key or connection | `auth_logout` with `revoke` | `userland auth logout --revoke` |
| List the businesses the owner belongs to | `accounts_list` | `userland accounts list` |
| Select the business to work in | `accounts_use` | `userland accounts use <account-id>` |
| See the business's plan and billing state | `accounts_status` | `userland accounts status` |
| See its limits and usage | `accounts_limits` | `userland accounts limits` |
| See what would stop working on a smaller plan | `accounts_downgrade_preview` with `plan` | `userland accounts downgrade preview --to <plan>` |
| List API keys | `api_keys_list` | `userland auth api-keys list` |
| Make an API key | `api_keys_create` with `name` | `userland auth api-keys create --name <name>` |
| Rename an API key | `api_keys_rename` with `name` | `userland auth api-keys rename <api-key-id> --name <name>` |
| Revoke an API key | `api_keys_revoke` with `confirm` | `userland auth api-keys revoke <api-key-id> --yes` |
| Ask Userland support | `support_open` with `subject`, `message` | `userland support open --subject <subject> --message <message>` |

## Validation checklist

- The business you act in is the one the owner means: check `auth_status` after selecting one.
- A plan change is the owner's own decision, made on the console's Billing page. Report limits and what a smaller plan would turn off; don't change the plan.
- A revoked key is one the owner named, and they know that anything using it stops working.

## Safety rules

- Never ask for or type a password, an API key or a secret value in the chat, and never print one.
- With the CLI, `auth api-keys create` prints the new key once in the terminal: don't repeat it in the chat, log it or save it in a file the owner didn't ask for. Pass a key to `auth save-key` on stdin, never with `--api-key`.
- Revoke a key or end a connection only when the owner asks. Show the key's name first; the connector and the CLI both ask for confirmation.
- Don't commit `~/.userland` credential files.
- Support requests go to Userland's team: put only what they need in them, and no secret values.

## References

- Agent context: https://docs.userland.fun/llms.txt
- Connector tools and their inputs: https://docs.userland.fun/reference/mcp/
- CLI: https://docs.userland.fun/reference/cli/
- Limits: https://docs.userland.fun/reference/limits/
- Getting help: https://docs.userland.fun/guides/getting-help/

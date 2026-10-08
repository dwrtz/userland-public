---
name: userland-publish-operate
description: Use when publishing or updating a Userland app, adding or deleting its secret keys, reading its errors or visits, undoing a bad version, inviting people to sign in, managing its short addresses and custom domains, getting its files or data back, or taking it offline.
---

# Userland publish and operate

Userland API version: v0

Use this skill when publishing, updating, checking on, undoing, or taking offline a Userland app, and for the work around it: secret keys, invites, addresses, and copies of its files or data.

## Connector or CLI

There are two ways into Userland. Both run the same operations, with the same permissions, checks, errors and plan limits. Find out which one you have before you start, and use it for the whole task.

- **The Userland connector.** Userland's tools, such as `auth_status` and `apps_publish`, are in your tool list: in ChatGPT or Claude with Userland added, or in a coding agent with the Userland plugin. Use the "Connector tool" column below. Don't switch to a terminal for any step, and don't ask the owner to install anything.
- **The Userland CLI.** There are no Userland tools, and you can run commands in a terminal. Use the "CLI command" column below. The CLI needs Node.js 20 or newer: `npm install -g @userland.fun/cli`.
- **Neither.** Tell the owner how to add Userland to their assistant: https://docs.userland.fun/guides/chat-assistants/.

When a tool or a command fails, tell the owner what its error says and follow its next steps. Don't retry the step the other way. Secret values and API keys never go in the chat: the connector gives the owner a Userland page to type a secret on, and the CLI reads one from stdin.

## Inputs

- The app's files: a folder (CLI) or a Userland draft (connector) that passes the check.
- The app id, when updating or operating an app that already exists.
- The names of the secret keys the app needs. The owner adds values that are theirs, such as a Stripe or AI provider key.
- When the owner has more than one business, which one: `account_id` with the connector (or select it once with `accounts_use`), `--account <account-id>` with the CLI.

## Outputs

- A published version, or the result of the operation.
- The app's address, app id, version id, activation status, and how to undo the change.

## Steps

1. Check who is signed in and which business is selected (`auth_status`, or `userland auth status`).
2. Check the files (`apps_validate`, or `userland validate <dir>`), and fix what it reports.
3. For each secret the app needs whose value is the owner's:
   - With the connector, call `secrets_set` with the app id and the secret's name. It gives you a single-use Userland page: send the owner that link, and they type the value there.
   - With the CLI, send the owner `https://console.userland.fun/apps/<app-id>/settings?add-key=<NAME>`, where they paste and save it. Set a value yourself, on stdin, only when you already have it.
   Never ask for the value in the chat.
4. Publish a new app, or a new version with the app id. Then read the result:
   - Tell the owner the app is live only when `activation_status` is `live`.
   - When it's stored but not live, say so, pass on the reasons (with the CLI, the `Why:` lines), and follow the next steps (the `Next:` lines). For `pending_secrets`, have the owner add each missing secret as in step 3, then publish again with the app id. Don't publish again without it: that makes a second app.
5. After publishing, read the app's versions and error events. Undo to the version before (`apps_rollback`) if the new one is wrong.
6. Take an app offline only when the owner asks (see Safety rules).
7. When the owner asks, invite people to sign in to an app that has sign-in, or delete a secret the app no longer uses.
8. When there's no copy of the app's files (a new chat or session, a lost folder, or the owner asks for one), get them back: with the connector, `apps_download` reads the live version's files (or an earlier version's); with the CLI, `userland apps download <app-id> [dir]` (CLI 0.13.0 or later) saves them to a folder. Change them, check them, and publish with the app id. Tell the owner what the copy doesn't have: the app's saved data, secret values, files whose names start with a dot, and the original source if the app was built before publishing.
9. When the owner asks for a copy of the app's data (records, the people who sign in, uploaded files), make one (owners and admins only): with the connector, `apps_export` makes it and hands back a link to download it, which you give only to the owner; with the CLI, `userland apps export <app-id> [dir]` (CLI 0.13.0 or later) saves it to a folder. The owner can also use "Download all saved data" on the app's settings page in the console. Tell them the copy has no passwords or secret values, and that it holds their customers' email addresses, so they should keep it somewhere private.

## Commands

| What to do | Connector tool | CLI command |
| --- | --- | --- |
| See who is signed in, and to which business | `auth_status` | `userland auth status` |
| List the business's apps | `apps_list` | `userland apps list` |
| See an app's status and live version | `apps_status` | `userland apps status <app-id>` |
| Check the app's files | `apps_validate` with `draft_id` | `userland validate <dir>` |
| Publish a new app | `apps_publish` with `draft_id` | `userland apps publish <dir>` |
| Publish a new version of an app | `apps_publish` with `draft_id`, `app_id` | `userland apps publish <dir> --app <app-id>` |
| Publish a new version with a note | `apps_publish` with `draft_id`, `app_id`, `message` | `userland apps publish <dir> --app <app-id> --message <message>` |
| See which secrets are set (names and dates only) | `secrets_list` | `userland apps secrets list <app-id>` |
| Add or replace a secret: the connector gives the owner a page to type it on, the CLI reads a value you already have from stdin | `secrets_set` | `printf '%s' "$VALUE" \| userland apps secrets set <app-id> <NAME>` |
| Delete a secret | `secrets_delete` with `confirm` | `userland apps secrets delete <app-id> <NAME> --yes` |
| List the app's versions | `apps_releases` | `userland apps releases <app-id>` |
| Read the newest error events | `apps_events` with `severity`, `limit` | `userland apps events <app-id> --severity error --limit 25` |
| Read the next, older page of events | `apps_events` with `severity`, `limit`, `cursor` | `userland apps events <app-id> --severity error --limit 25 --cursor <cursor>` |
| Undo to an earlier version | `apps_rollback` | `userland apps rollback <app-id> <release-id>` |
| See the app's visits | `apps_analytics` with `range` | `userland apps analytics <app-id> --range 30d` |
| Invite someone to sign in to the app | `invites_create` with `email`, `roles`, `expires_in_days` | `userland apps invites create <app-id> --email <email> --role <role> --expires-in-days <days>` |
| List the app's addresses | `routes_list` | `userland apps routes list <app-id>` |
| List its short addresses | `slugs_list` | `userland apps slugs list <app-id>` |
| Add a short address | `slugs_add` | `userland apps slugs add <app-id> <slug>` |
| Remove a short address | `slugs_remove` | `userland apps slugs remove <app-id> <slug>` |
| List its custom domains and their DNS records | `domains_list` | `userland apps domains list <app-id>` |
| Add a custom domain | `domains_add` | `userland apps domains add <app-id> <hostname>` |
| Check a custom domain's DNS records | `domains_verify` | `userland apps domains verify <app-id> <hostname>` |
| Remove a custom domain | `domains_remove` | `userland apps domains remove <app-id> <hostname>` |
| Get the files of the live version back | `apps_download` | `userland apps download <app-id> [dir]` |
| Get the files of an earlier version back | `apps_download` with `release_id` | `userland apps download <app-id> [dir] --version <release-id>` |
| Get a copy of the app's data | `apps_export` | `userland apps export <app-id> [dir]` |
| Get a copy of one collection's records, without uploaded files | `apps_export` with `collection`, `no_files` | `userland apps export <app-id> [dir] --collection <name> --no-files` |
| Take an app offline | `apps_unpublish` with `confirm` | `userland apps unpublish <app-id> --yes` |

If `secrets list`, `secrets delete`, `invites create`, `apps download`, `apps export`, or `--cursor` is not found, update the CLI first: `npm install -g @userland.fun/cli`. A bundle over 16 MiB needs CLI 0.13.0 or later, which publishes it in an upload session by itself (more lines at the end of the output: `upload_id=`, `upload_files_sent=`, `upload_files_copied=`); an older CLI sends it in one request, which the API can refuse, so update first.

Events come newest first. When there are more, the result gives a cursor (with the CLI, a last line `cursor=<cursor>`); pass it to read the next, older page.

## Validation checklist

- Every required secret is set (`secrets_list`). If activation is `pending_secrets`, have the owner add each missing one, and publish again with the app id once they say it's saved.
- The activation status is reported, and the app is called live only when it's `live`.
- The version id to undo to is recorded.
- An app that the owner's website shows in a frame keeps its `runtime.embed_origins` in every version. The list belongs to the version: publishing without it stops the embed, and undoing to an earlier version brings back that version's list.

## Safety rules

- Never ask the owner to paste a secret value or an API key into the chat, and never print one. To see which secrets are set, use `secrets_list`, which shows only names and dates.
- With the CLI, pass secret values and API keys on stdin, as in the table, never with `--value` or `--api-key`, so they stay out of shell history, process lists and transcripts. Don't commit `.env` files or `~/.userland` credential files.
- Publishing a folder leaves out dotfiles such as `.env`, `.npmrc` and `.git/`, refuses private keys, and never follows symlinks. If the CLI reports `dotfiles_skipped`, `symlink` or `private_key`, publish a build folder rather than working around it.
- Always pass the app id when updating an app; without it, Userland makes a new app.
- Take offline only apps the owner named or confirmed. It removes the app's addresses, short addresses and custom domains. List the apps first (`apps_list`), show the owner the app's name and id, and wait for a clear yes. The connector asks for confirmation itself; the CLI needs `--yes` without a terminal, and piping `y` doesn't confirm. When the owner has more than one business, pass the same business to the list and to taking it offline, so an app in another business isn't removed.
- Delete a secret only when the owner asks. First check that the app's code no longer reads it, and remove it from `resources.secrets.required`, or the next version you publish won't go live (`pending_secrets`) until it's set again.
- Invite people with `invites_create` (or `userland apps invites create`), not a new API key. Give a role once for each role the manifest declares, or none for no special role. The invite link lets whoever has it set the person's password once: give it only to the owner who asked, and don't log or save it. An invite is only for someone with no account in the app yet; for an email that already has one, setting the password fails with `409 user_exists` and gives no new role, and there's no way yet to change an existing person's roles, so tell the owner that instead.
- Don't publish app aliases. Check an app at its own address.

## References

- Agent context: https://docs.userland.fun/llms.txt
- Connector tools and their inputs: https://docs.userland.fun/reference/mcp/
- CLI: https://docs.userland.fun/reference/cli/
- Secrets: https://docs.userland.fun/guides/secrets/
- Rollback: https://docs.userland.fun/guides/rollback/
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting/

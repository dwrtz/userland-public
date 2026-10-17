---
name: userland-manifest-resources
description: Use when a Userland app needs sign-in and roles, saved data, file uploads, secret keys, scheduled tasks or webhooks, or must show inside the owner's own website. Covers declaring them in manifest.userland.json and checking the manifest against the owner's plan.
---

# Userland manifest resources

Userland API version: v0

Use this skill when declaring an app's resources in `manifest.userland.json`, or the sites allowed to show the app in a frame (`runtime.embed_origins`).

## Connector or CLI

There are two ways into Userland. Both run the same operations, with the same permissions, checks, errors and plan limits. Find out which one you have before you start, and use it for the whole task.

- **The Userland connector.** Userland's tools, such as `auth_status` and `apps_publish`, are in your tool list: in ChatGPT or Claude with Userland added, or in a coding agent with the Userland plugin. Use the "Connector tool" column below. Don't switch to a terminal for any step, and don't ask the owner to install anything.
- **The Userland CLI.** There are no Userland tools, and you can run commands in a terminal. Use the "CLI command" column below. The CLI needs Node.js 20 or newer: `npm install -g @userland.fun/cli`.
- **Neither.** Tell the owner how to add Userland to their assistant: https://docs.userland.fun/guides/chat-assistants/.

When a tool or a command fails, tell the owner what its error says and follow its next steps. Don't retry the step the other way. Secret values and API keys never go in the chat: the connector gives the owner a Userland page to type a secret on, and the CLI reads one from stdin.

## Inputs

- What the app must do, and who signs in to it.
- Its data, access rules, file uploads, secret key names, scheduled tasks and webhooks.
- The existing manifest, when changing an app.

## Outputs

- A valid `resources` object for Userland v0, and `runtime.embed_origins` when needed.
- Notes for the server code on how to use each resource.

## Steps

1. Start from https://docs.userland.fun/reference/resource-manifest/.
2. Declare only the resources the app uses.
3. Use `auth` for the people who sign in to the app, and their roles.
4. Use `data.collections` for saved records.
5. Use `files.stores` for uploads.
6. Use `secrets.required` for the names of server-only secret keys. The values never go in the manifest.
7. Use `jobs` and `webhooks` only when server code handles them.
8. Add `runtime.embed_origins` only when the owner's own website must show the app inside its pages in an `<iframe>`. By default no other site or Userland app can show an app in a frame. List the owner's sites, for example `"embed_origins": ["https://www.<customer-domain>", "https://*.<customer-domain>"]`: each entry is `https://`, a domain name and an optional port, optionally starting with `*.` for subdomains, with no path or trailing slash, and at most 20 entries. Inside the frame the app runs signed out, so embed public pages and link to the app for anything that needs sign-in. See https://docs.userland.fun/guides/embedding/.
9. Check the manifest and files against the owner's plan (`apps_validate`, or `userland validate`), and tell the owner about anything that needs a paid plan before you publish. When you change an app that's already live, see the `userland-debug-migrate` skill for changes to saved data.

## Commands

| What to do | Connector tool | CLI command |
| --- | --- | --- |
| Check the manifest and files, and the smallest plan they fit | `apps_validate` with `draft_id` | `userland validate <dir>` |
| Check them against the owner's plan | `apps_validate` with `draft_id`, `plan` | `userland validate <dir> --plan <plan>` |
| Treat schema warnings as errors | `apps_validate` with `draft_id`, `strict` | `userland validate <dir> --strict` |
| See the plan's limits and usage | `accounts_limits` | `userland accounts limits` |
| See which secrets an app has (names only) | `secrets_list` | `userland apps secrets list <app-id>` |

## Validation checklist

- Collection, field, index, job, webhook and store names are stable: renaming one is a change to saved data.
- Access rules match who should see and change each record.
- Each required secret is named, and the owner knows where to add its value.
- Server code uses only the resources the manifest declares.
- `runtime.embed_origins` lists only sites the owner has and asked to show the app on; the check reports any entry Userland would refuse.

## Safety rules

- Never put a secret value in `manifest.userland.json` or in browser code.
- Don't create resources at runtime that the manifest doesn't declare.
- Don't publish files under `_userland/`.
- Never list another Userland app or address (`*.userland.link`, `userland.fun` and anything on it) in `runtime.embed_origins`, and never try to allow every site; the check and publishing refuse both.

## References

- Agent context: https://docs.userland.fun/llms.txt
- Resource manifest: https://docs.userland.fun/reference/resource-manifest/
- Connector tools and their inputs: https://docs.userland.fun/reference/mcp/
- CLI: https://docs.userland.fun/reference/cli/
- Limits: https://docs.userland.fun/reference/limits/

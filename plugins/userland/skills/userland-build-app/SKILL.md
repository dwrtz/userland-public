---
name: userland-build-app
description: Use when someone wants a new app, tool, form or website for their business built and published on Userland. Covers planning it from their description, writing the manifest, pages and server code, checking it, and publishing it with the Userland connector or the CLI.
---

# Userland build app

Userland API version: v0

Use this skill to turn an owner's idea into a published Userland app. An app is a folder of files: `manifest.userland.json`, pages under `public/`, and `server/index.js` when it needs server code.

## Connector or CLI

There are two ways into Userland. Both run the same operations, with the same permissions, checks, errors and plan limits. Find out which one you have before you start, and use it for the whole task.

- **The Userland connector.** Userland's tools, such as `auth_status` and `apps_publish`, are in your tool list: in ChatGPT or Claude with Userland added, or in a coding agent with the Userland plugin. Use the "Connector tool" column below. Don't switch to a terminal for any step, and don't ask the owner to install anything.
- **The Userland CLI.** There are no Userland tools, and you can run commands in a terminal. Use the "CLI command" column below. The CLI needs Node.js 20 or newer: `npm install -g @userland.fun/cli`.
- **Neither.** Tell the owner how to add Userland to their assistant: https://docs.userland.fun/guides/chat-assistants/.

When a tool or a command fails, tell the owner what its error says and follow its next steps. Don't retry the step the other way. Secret values and API keys never go in the chat: the connector gives the owner a Userland page to type a secret on, and the CLI reads one from stdin.

## Inputs

- What the owner wants, in their words: who uses the app, and what it should do.
- The services it connects to, and the names of any secret keys those need (never the values).
- Optional: an example to start from (see the `userland-adapt-examples` skill), or the app id of an app to update.

## Outputs

- `manifest.userland.json`, `public/` files, and `server/index.js` when the app needs server code.
- A published app, and a report for the owner: its address, what it does, how they and their customers use it, anything that needs a paid plan, and how to undo a change.

## Steps

1. Read https://docs.userland.fun/llms.txt before you write anything, and don't guess how Userland works.
2. Check who is signed in and which business you're working in (`auth_status`, or `userland auth status`). With the CLI, if no one is signed in, run `userland login`: it opens the browser, and the owner approves there. With the connector, connecting was the sign-in.
3. If the owner hasn't said what they need, ask first: what the app is for, who uses it, and what it must do.
4. Choose the smallest example that matches from https://github.com/dwrtz/userland-public/blob/main/catalog.json, by what it does rather than how it looks. Check the plan's limits (`accounts_limits`, or `userland accounts limits`) before choosing features that need a paid plan: each example lists its `required_plan` and `paid_features`.
5. Write the manifest first, with only the resources the app uses (see the `userland-manifest-resources` skill). If the owner's own website will show the app in an `<iframe>`, add that site to `runtime.embed_origins`.
6. Add the pages under `public/`, and `server/index.js` only when the app needs routes, saved data, sign-in, secrets, scheduled tasks, files or webhooks (see the `userland-runtime-code` skill).
7. Check the files. With the CLI, they're a folder on disk: run `userland validate <dir>`. With the connector, put them in a Userland draft with the connector's draft tools (its tool list names them), then pass the draft's `draft_id` to `apps_validate`. Fix every error it reports.
8. For each secret key the app needs, have the owner add the value themselves (see the `userland-publish-operate` skill). Never ask for it in the chat.
9. Publish (`apps_publish`, or `userland apps publish <dir>`). To update an app, always pass its app id (`app_id`, or `--app <app-id>`); without it, Userland makes a second app.
10. Report to the owner, as in Outputs. Tell them the app is live only when `activation_status` is `live`.

## Commands

| What to do | Connector tool | CLI command |
| --- | --- | --- |
| See who is signed in, and to which business | `auth_status` | `userland auth status` |
| See the plan's limits and usage | `accounts_limits` | `userland accounts limits` |
| Check the files, and the smallest plan they fit | `apps_validate` with `draft_id` | `userland validate <dir>` |
| Check the files against one plan | `apps_validate` with `draft_id`, `plan` | `userland validate <dir> --plan <plan>` |
| Publish a new app | `apps_publish` with `draft_id` | `userland apps publish <dir>` |
| Publish a new version of an app | `apps_publish` with `draft_id`, `app_id` | `userland apps publish <dir> --app <app-id>` |

## Validation checklist

- The manifest has `app.name`, and every runtime path it names exists.
- `runtime.embed_origins` is left out unless the owner's own website shows the app.
- No file is under `_userland/`.
- Pages and browser code hold no API keys or secret values.
- The check (`apps_validate`, or `userland validate`) passes before publishing.
- The report gives the app id, address, version id and activation status, and how to undo a change.

## Safety rules

- Never show or ask for an API key or a secret value in the chat, and never put one in a page or browser code.
- Don't make up how Userland works: use the documented manifest, API and runtime `ctx`.
- Always pass the app id when updating an app.
- Publish only what the owner asked for. Ask before anything that needs a paid plan.

## References

- Agent context: https://docs.userland.fun/llms.txt
- Connector tools and their inputs: https://docs.userland.fun/reference/mcp/
- CLI: https://docs.userland.fun/reference/cli/
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting/
- Examples: https://github.com/dwrtz/userland-public/tree/main/examples

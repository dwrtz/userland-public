---
name: userland-adapt-examples
description: Use when starting a Userland app from one of the public examples, such as the booking app, invoice generator, job board, link in bio, mini CRM or waitlist. Covers choosing the closest one, copying only what the app needs, renaming and trimming it, checking it, and publishing it.
---

# Userland adapt examples

Userland API version: v0

Use this skill when copying a Userland example into a new app.

## Connector or CLI

There are two ways into Userland. Both run the same operations, with the same permissions, checks, errors and plan limits. Find out which one you have before you start, and use it for the whole task.

- **The Userland connector.** Userland's tools, such as `auth_status` and `apps_publish`, are in your tool list: in ChatGPT or Claude with Userland added, or in a coding agent with the Userland plugin. Use the "Connector tool" column below. Don't switch to a terminal for any step, and don't ask the owner to install anything.
- **The Userland CLI.** There are no Userland tools, and you can run commands in a terminal. Use the "CLI command" column below. The CLI needs Node.js 20 or newer: `npm install -g @userland.fun/cli`.
- **Neither.** Tell the owner how to add Userland to their assistant: https://docs.userland.fun/guides/chat-assistants/.

When a tool or a command fails, tell the owner what its error says and follow its next steps. Don't retry the step the other way. Secret values and API keys never go in the chat: the connector gives the owner a Userland page to type a secret on, and the CLI reads one from stdin.

## Inputs

- The owner's idea, and the changes they want.
- An example from https://github.com/dwrtz/userland-public/blob/main/catalog.json.

## Outputs

- A new app made from the example: its manifest, pages and server code, renamed and trimmed.
- A check result, and the published app's address when the owner asked to publish.

## Steps

1. Choose the closest example by what it does, not how it looks. Each catalog entry lists its `required_plan` and `paid_features`: check them against the owner's plan (`accounts_limits`, or `userland accounts limits`).
2. Read the example's `README.md` and `AGENT.md`, then its files, at https://github.com/dwrtz/userland-public/tree/main/examples/<example-slug>. With a terminal, clone the repo or download the folder. With the connector, write the files you need into a Userland draft with its draft tools.
3. Copy only the files the new app needs.
4. Rename the app's name, collections, stores, jobs and webhooks to suit the new app.
5. Remove the resources, routes and secrets it doesn't use, and the example's demo mode.
6. Check it (`apps_validate`, or `userland validate <dir>`), then publish it as a new app (see the `userland-publish-operate` skill).
7. To start from an app the owner already published instead, get its files back first (`apps_download`, or `userland apps download <app-id> [dir]`).

## Commands

| What to do | Connector tool | CLI command |
| --- | --- | --- |
| See who is signed in, and to which business | `auth_status` | `userland auth status` |
| See the plan's limits, to compare with the example's `required_plan` | `accounts_limits` | `userland accounts limits` |
| Get the files of one of the owner's published apps | `apps_download` | `userland apps download <app-id> [dir]` |
| Check the new app against the owner's plan | `apps_validate` with `draft_id`, `plan` | `userland validate <dir> --plan <plan>` |
| Publish it as a new app | `apps_publish` with `draft_id` | `userland apps publish <dir>` |

## Validation checklist

- No secret names from the example remain unless the new app still reads them.
- The app's name, routes and texts fit the new app, with nothing left from the example's demo.
- Resources the new app doesn't use are gone from the manifest.
- When the new app is itself an example in userland-public, it has `README.md`, `AGENT.md`, `example.json` and `manifest.userland.json`, its `catalog.json` entry matches `example.json`, and `npm run validate:catalog` and `npm run validate:manifests` pass.

## Safety rules

- Don't leave sample secrets or keys in the adapted code.
- Don't keep admin routes the new app doesn't need.
- Don't publish until unused resources are removed.
- Say which example the app started from.

## References

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example/
- Examples: https://github.com/dwrtz/userland-public/tree/main/examples
- Connector tools and their inputs: https://docs.userland.fun/reference/mcp/
- CLI: https://docs.userland.fun/reference/cli/

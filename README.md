# Userland examples

This repo is the public agent toolkit for building and publishing Userland apps.

Use it with the docs at https://docs.userland.fun, especially:

- https://docs.userland.fun/llms.txt
- https://docs.userland.fun/quickstarts/from-example
- https://docs.userland.fun/skills
- https://docs.userland.fun/reference/agent-skills
- https://docs.userland.fun/reference/cli

## For agents

Goal: choose an example, adapt it into a valid Userland app bundle, validate it, and publish it with the Userland CLI or API.

Inputs:

- App idea and desired capabilities.
- Node.js 20 or newer for the Userland CLI (check with `node --version`).
- `USERLAND_API_KEY` in the environment, or an API key saved after browser approval with `userland signup` or `userland login`.
- Optional `USERLAND_ACCOUNT_ID` or saved CLI account selection for team/client workspaces.
- Optional target `app_id` for updates.

Outputs:

- `manifest.userland.json`.
- Static files under `public/`.
- `server/index.js` when dynamic routes, resources, jobs, or webhooks are needed.
- Publish report with `app_id`, origin, release id, activation status, and rollback instructions.

## How to use this repo

1. Read `catalog.json` to choose an example by capability, difficulty, and `required_plan`. Each entry also lists `paid_features`, the manifest features that need more than the Free plan. Check your plan with `userland accounts limits`.
2. Open the matching example directory.
3. Read the example `README.md` and `AGENT.md`.
4. Use the repo-scoped skills in `.agents/skills` when working in Codex.
5. Validate before publishing. `userland validate <dir> --plan <plan>` checks the manifest, files, and plan limits offline; `apps publish` runs the same checks first.

```sh
userland validate examples/<example-slug>
userland validate examples/<example-slug> --plan free --json
npm run typecheck
npm run cli:test
npm test
npm run validate:catalog
npm run validate:manifests
npm run validate:skills
```

## Repository policy

This repo is canonical for user-facing examples, repo-scoped Codex skills, and the launch public CLI source. The main Userland monorepo may keep smaller platform test fixtures, but docs catalogs and agent workflows should point here.

During this phase, `cli/` is the public CLI source of truth. CLI changes should land here with `npm run typecheck`, `npm run cli:test`, and `npm test` passing, then the main Userland docs should be updated in the same release window.

## CLI

The CLI needs Node.js 20 or newer. Check with `node --version`; if Node is missing or older, install the current LTS release from https://nodejs.org/ first.

Install the public CLI globally:

```sh
npm install -g @userland.fun/cli
```

If a global install fails with a permission error (`EACCES`), run it without installing instead: `npx @userland.fun/cli --version`, then use `npx @userland.fun/cli` wherever these docs say `userland`.

Then run:

```sh
userland --version
userland login
userland validate examples/<example-slug>
userland apps publish examples/<example-slug>
userland apps analytics <app-id> --range 30d
userland accounts list
userland accounts use <account-id>
userland support open --subject "Deploy failed" --message "The latest release is throwing errors." --app <app-id>
USERLAND_ACCOUNT_ID=<account-id> userland apps list
```

From this repo, run it from source:

```sh
npm run userland -- login
npm run userland -- validate examples/<example-slug> --plan free
npm run userland -- apps publish examples/<example-slug>
npm run userland -- apps publish examples/<example-slug> --account <account-id>
npm run userland -- support open --subject "Deploy failed" --message "The latest release is throwing errors." --app <app-id>
```

`userland validate` needs no API key. It reports the lowest plan an app needs; `--plan free|starter|business|business_plus` fails on anything the chosen plan does not include (exit code `2`). Features beyond Business Plus are not available on self-serve plans; contact support for those. Plan limits: https://docs.userland.fun/reference/limits/. The Userland API still enforces plan limits when you publish.

The CLI starts a browser device-authorization flow for login and signup, then keeps the approved API key and optional selected `account_id` in `~/.userland/credentials.json`. It does not store platform passwords. Most single-user flows do not need account selection; use it when publishing into a team or client account.

## Safety rules

- Never put `USERLAND_API_KEY` in static files, examples, screenshots, or commits.
- Never expose app secrets to frontend code.
- Use `ctx.secrets` only from server runtime code.
- Do not publish files under `_userland/`.
- Do not invent platform internals or raw infrastructure config.
- Use app origins like `https://<app_id>.userland.link/`.

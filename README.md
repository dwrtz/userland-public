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
- `USERLAND_API_KEY` in the environment, or an API key saved with `userland signup` or `userland login`.
- Optional `USERLAND_ACCOUNT_ID` or saved CLI account selection for team/client workspaces.
- Optional target `app_id` for updates.

Outputs:

- `manifest.userland.json`.
- Static files under `public/`.
- `server/index.js` when dynamic routes, resources, jobs, or webhooks are needed.
- Publish report with `app_id`, origin, release id, activation status, and rollback instructions.

## How to use this repo

1. Read `catalog.json` to choose an example by capability and difficulty.
2. Open the matching example directory.
3. Read the example `README.md` and `AGENT.md`.
4. Use the repo-scoped skills in `.agents/skills` when working in Codex.
5. Validate before publishing.

```sh
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

Install the public CLI globally:

```sh
npm install -g @userland.fun/cli
```

Then run:

```sh
userland signup --username <username>
userland apps publish examples/<example-slug>
userland accounts list
userland accounts use <account-id>
USERLAND_ACCOUNT_ID=<account-id> userland apps list
```

From this repo, run it from source:

```sh
npm run userland -- signup --username <username>
npm run userland -- apps publish examples/<example-slug>
npm run userland -- apps publish examples/<example-slug> --account <account-id>
```

The CLI keeps API keys and optional selected `account_id` in `~/.userland/credentials.json` and stores account username/password in the OS keychain. Most single-user flows do not need account selection; use it when publishing into a team or client account.

## Safety rules

- Never put `USERLAND_API_KEY` in static files, examples, screenshots, or commits.
- Never expose app secrets to frontend code.
- Use `ctx.secrets` only from server runtime code.
- Do not publish files under `_userland/`.
- Do not invent platform internals or raw infrastructure config.
- Use app origins like `https://<app_id>.apps.userland.fun/`.

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
- `USERLAND_API_KEY` in the environment for publishing.
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
npm test
npm run validate:catalog
npm run validate:manifests
npm run validate:skills
```

## CLI

The public CLI source lives in `cli/`. Until `@userland/cli` is published to npm, run it from source:

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/<example-slug>
```

## Safety rules

- Never put `USERLAND_API_KEY` in static files, examples, screenshots, or commits.
- Never expose app secrets to frontend code.
- Use `ctx.secrets` only from server runtime code.
- Do not publish files under `_userland/`.
- Do not invent platform internals or raw infrastructure config.
- Use app origins like `https://<app_id>.apps.userland.fun/`.


# Agent notes

Goal: adapt a static-only Userland app.

Plan: `required_plan` is `free`; `paid_features` is `[]`. A static app with `app.visibility: "public"` publishes on every plan. Private apps (`visibility: "private"`) aren't available yet; use sign-in with roles to limit who can see the app's pages and data.

Inputs:

- Static page content.
- Optional CSS, browser JavaScript, and images.

Outputs:

- `manifest.userland.json` with `runtime.static_root: "public"` and no `resources`.
- Files under `public/`.

Steps:

1. Rename `app.name`, `app.summary`, and `app.tags`. Tags must be lowercase words and cannot be reserved names such as `secrets` or `auth`.
2. Add static assets under `public/`. Keep `runtime.fallback` as `index.html` for a single-page app, or use `404`.
3. Do not add `server/index.js` unless the app needs dynamic routes or managed resources; start from `server-notes` instead.
4. Validate: `npm run validate:manifests -- hello-static`.
5. Check the account before publishing: `userland auth status`, then `userland apps publish examples/hello-static`.

Safety:

- Do not put `USERLAND_API_KEY` or any other key in static files.
- Do not publish files under `_userland/`.
- Do not call the Userland control-plane API from browser code.

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Plan limits: https://docs.userland.fun/reference/limits

Capability docs:

- Static quickstart: https://docs.userland.fun/quickstarts/static-app
- Rollback: https://docs.userland.fun/guides/rollback

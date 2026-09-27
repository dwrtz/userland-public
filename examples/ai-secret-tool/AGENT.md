# Agent notes

Goal: adapt a server-only model-provider integration.

Plan: `required_plan` is `free`; `paid_features` is `[]`. Free allows one entry in `resources.secrets.required`; adding a second secret needs Starter (`secrets.required.max`).

Inputs:

- Provider API shape.
- Secret name.
- Prompt or tool input.

Outputs:

- Manifest with one required secret.
- Server route that reads the secret through `ctx.secrets.require`.
- Frontend that calls only the app server.

Steps:

1. Keep provider calls in `server/index.js`.
2. Replace `callMockModel` with the provider request. Read the key with `ctx.secrets.require("MODEL_API_KEY")` inside the request handler.
3. Validate prompt input before reading the secret, and return only sanitized model output.
4. Secret names must be uppercase and cannot start with `USERLAND_`, `CF_`, or `CLOUDFLARE_`. App tags cannot be reserved names such as `secrets`.
5. Validate: `npm run validate:manifests -- ai-secret-tool` and `npx vitest run examples/ai-secret-tool`.
6. The first publish creates the app, but its release stays `pending_secrets` and is not live. Setting the secret does not activate it. Set it with `printf '%s' "$MODEL_API_KEY" | userland apps secrets set <app-id> MODEL_API_KEY`, then publish again into the same app with `userland apps publish examples/ai-secret-tool --app <app-id>` (without `--app` the CLI creates a second app).
7. Before connecting a paid provider key, protect `/api/run` with app sign-in (`resources.auth` plus a `ctx.auth.currentUser(request)` check returning 401) or a per-user rate limit. As shipped, anyone with the URL can call it and spend the provider credit.

Safety:

- Do not put provider keys in frontend files.
- Do not ship a real provider key behind an unauthenticated, unlimited `/api/run`.
- Do not return, log, or echo any part of a secret, including a prefix.
- Do not log prompts; they may contain private user data. Log sizes or ids instead.

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

- Secrets: https://docs.userland.fun/guides/secrets
- Auth: https://docs.userland.fun/guides/auth

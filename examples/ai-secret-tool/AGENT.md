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
- Frontend (`public/index.html`, `public/assets/app.js`) that calls only the app server.

Steps:

1. Keep provider calls in `server/index.js`.
2. Replace `callMockModel` with the provider request, and in the same change add sign-in and a daily limit. As shipped, anyone with the URL can call `/api/run`; with a real key every call spends the owner's credit. Do not publish a real key without both:
   - Manifest (still Free): add `"auth": { "mode": "app_users", "roles": ["member"], "public_signup": false }` and a collection `"usage": { "fields": { "key": "string", "count": "integer" }, "indexes": [{ "name": "by_key", "fields": ["key"], "unique": true }], "access": { "read": "server_only", "write": "server_only" } }`. Add `"auth"` and `"data"` to `capabilities` in `example.json` and `catalog.json`.
   - Code: at the top of `runTool`, `const user = await ctx.auth.currentUser(request)`; return `401` when there is none and `403` without the `member` role. Then look up the row with `key = user.app_user_id + ":" + today (YYYY-MM-DD)` via `list({ where: { key }, limit: 1 })`; return `429` once `count` reaches your daily limit, otherwise `update` it to `count + 1` (or `create` it with `count: 1`, treating `unique_conflict` as "someone else just created it, read it again"). The read-then-write can let a couple of simultaneous calls through; it is a budget, not an exact counter.
   - Invite each person with `userland apps invites create <app-id> --email <email> --role member` (CLI 0.9.0 or later; Auth guide), give each link only to the user who asked for it, and point the page at `/_userland/auth/login?return_to=/` for signed-out visitors.
   Read the key with `ctx.secrets.require("MODEL_API_KEY")` inside the request handler, and pass `MAX_ANSWER_TOKENS` as the provider's output limit.
3. Validate prompt input before reading the secret, and return only sanitized model output. Keep the `try`/`catch` around `model.call`: provider SDK errors carry `code` and `status`, and the platform returns an uncaught error's message and status to the visitor, which can expose part of the key or billing state. Log only `status` and `code`.
4. Keep the same-origin check (`isSameOrigin`) and `readJson` requiring `content-type: application/json` on `/api/run`, so other sites (including other `*.userland.link` apps) cannot call it through a visitor's browser. Once you add sign-in, this is also what stops them acting as a signed-in member.
5. Secret names must be uppercase and cannot start with `USERLAND_`, `CF_`, or `CLOUDFLARE_`. App tags cannot be reserved names such as `secrets`.
6. Validate: `npm run validate:manifests -- ai-secret-tool` and `npx vitest run examples/ai-secret-tool`.
7. The first publish creates the app, but its release stays `pending_secrets` and is not live. Setting the secret does not activate it. The key is the owner's: send them `https://console.userland.fun/apps/<app-id>/settings?add-key=MODEL_API_KEY`, where they paste and save it, instead of asking for it in chat. If you already have the value, or the console says it can't save keys right now, set it with `printf '%s' "$MODEL_API_KEY" | userland apps secrets set <app-id> MODEL_API_KEY` without printing it. Then publish again into the same app with `userland apps publish examples/ai-secret-tool --app <app-id>` (without `--app` the CLI creates a second app).

Safety:

- Do not put provider keys in frontend files.
- Do not ship a real provider key behind an unauthenticated, unlimited `/api/run` (step 2).
- Do not return a provider error's message to the visitor.
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

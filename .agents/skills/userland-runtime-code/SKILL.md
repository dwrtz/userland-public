---
name: userland-runtime-code
description: Userland runtime ctx server code for routes, data, auth, secrets, files, jobs, and logs.
---

# Userland runtime code

Userland API version: v0

Use this skill when writing `server/index.js` for a Userland app.

## Inputs

- Manifest runtime and resources.
- Route list.
- Data, auth, file, secret, job, and webhook behavior.

## Outputs

- `server/index.js` exporting runtime handlers.
- Route responses with correct status codes and content types.
- Server-only secret and resource access.

## Steps

1. Read https://docs.userland.fun/reference/runtime-ctx.
2. Export a default object with `fetch(request, ctx)` when HTTP routing is needed.
3. Add `job(event, ctx)` only for declared jobs.
4. Use `ctx.data`, `ctx.auth`, `ctx.files`, `ctx.secrets`, and `ctx.log` according to docs.
5. Keep browser-facing responses sanitized.
6. Return explicit 404 responses for unknown dynamic routes.

## Commands

```sh
npm run validate:manifests
```

## Validation checklist

- Server entry path matches `runtime.server_entry`.
- No frontend file imports server-only code.
- Secret values only flow through `ctx.secrets`.
- Logs omit API keys and secret values.

## Safety rules

- Never put `USERLAND_API_KEY` in runtime source.
- Never send app secrets to the browser.
- Do not use undocumented `ctx` fields.
- Do not depend on raw infrastructure APIs.


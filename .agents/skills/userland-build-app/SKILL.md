---
name: userland-build-app
description: Userland app build workflow from idea to valid bundle.
---

# Userland build app

Userland API version: v0

Use this skill when turning an app idea into a Userland bundle.

## Inputs

- App idea, target audience, and required capabilities.
- Existing repo or empty directory.
- Optional example selected from `catalog.json`.

## Outputs

- `manifest.userland.json`.
- `public/` files for static UI.
- `server/index.js` when routes, data, auth, secrets, jobs, files, or webhooks are needed.
- Validation and publish summary.

## Steps

1. Read https://docs.userland.fun/llms.txt.
2. Choose the smallest matching example from `catalog.json`.
3. Create or adapt the manifest first.
4. Add static UI files under `public/`.
5. Add `server/index.js` only when dynamic behavior is required.
6. Validate the manifest and referenced files.
7. Publish only after the user has supplied `USERLAND_API_KEY` through the environment.

## Commands

```sh
npm run validate:catalog
npm run validate:manifests
USERLAND_API_KEY=... npm run userland -- apps publish examples/<example-slug>
```

## Validation checklist

- Manifest has `app.name`.
- Runtime paths exist.
- Release files do not include `_userland/`.
- Frontend code does not contain API keys or app secrets.
- Publish report includes `app_id`, origin, release id, activation status, and rollback instructions.

## Safety rules

- Never expose `USERLAND_API_KEY`.
- Never expose app secrets to frontend code.
- Do not invent infrastructure config.
- Use documented Userland APIs and runtime `ctx` methods.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

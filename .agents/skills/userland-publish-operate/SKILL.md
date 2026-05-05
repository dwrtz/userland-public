---
name: userland-publish-operate
description: Userland app publish, secrets, events, releases, and rollback operations.
---

# Userland publish and operate

Userland API version: v0

Use this skill when publishing, updating, inspecting, or rolling back a Userland app.

## Inputs

- Valid app bundle directory.
- `USERLAND_API_KEY` in the environment.
- Optional `app_id` for updates.
- Required app secret values.

## Outputs

- Published release or operation result.
- App origin, release id, activation status, and rollback command.

## Steps

1. Validate catalog, skills, and manifests.
2. Set required app secrets before relying on runtime secret access.
3. Publish a new app or update an existing app.
4. Inspect releases and events after publishing.
5. Roll back if activation or runtime behavior is wrong.

## Commands

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/<example-slug>
USERLAND_API_KEY=... npm run userland -- apps publish examples/<example-slug> --app <app-id>
USERLAND_API_KEY=... npm run userland -- apps secrets set <app-id> <NAME> --value <value>
USERLAND_API_KEY=... npm run userland -- apps releases <app-id>
USERLAND_API_KEY=... npm run userland -- apps events <app-id>
USERLAND_API_KEY=... npm run userland -- apps rollback <app-id> <release-id>
```

## Validation checklist

- `USERLAND_API_KEY` is present only in the process environment.
- Required secrets are set.
- Activation status is reported.
- Rollback release id is recorded.

## Safety rules

- Do not print API keys or secret values.
- Do not commit `.env` files.
- Do not publish app aliases.
- Use app origins for validation.


---
name: userland-publish-operate
description: Userland app publish, secrets, events, releases, and rollback operations.
---

# Userland publish and operate

Userland API version: v0

Use this skill when publishing, updating, inspecting, or rolling back a Userland app.

## Inputs

- Valid app bundle directory.
- `USERLAND_API_KEY` in the environment or an API key saved by the CLI.
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
npm run userland -- auth status
npm run userland -- apps publish examples/<example-slug>
npm run userland -- apps publish examples/<example-slug> --app <app-id>
npm run userland -- apps secrets set <app-id> <NAME> --value <value>
npm run userland -- apps releases <app-id>
npm run userland -- apps events <app-id>
npm run userland -- apps rollback <app-id> <release-id>
```

## Validation checklist

- Authentication is available from `USERLAND_API_KEY` or saved CLI credentials.
- Required secrets are set.
- Activation status is reported.
- Rollback release id is recorded.

## Safety rules

- Do not print API keys or secret values.
- Do not commit `.env` files.
- Do not commit `~/.userland` credential files.
- Do not publish app aliases.
- Use app origins for validation.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

---
name: userland-publish-operate
description: Userland app publish, secrets, events, releases, and rollback operations.
---

# Userland publish and operate

Userland API version: v0

Use this skill when publishing, updating, inspecting, rolling back, or unpublishing a Userland app.

## Inputs

- Valid app bundle directory.
- Userland CLI installed as `@userland.fun/cli`.
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
6. Unpublish test or demo apps the user no longer needs, only when the user asks.

## Commands

```sh
userland auth status
userland apps publish examples/<example-slug>
userland apps publish examples/<example-slug> --app <app-id>
printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>
userland apps releases <app-id>
userland apps events <app-id>
userland apps rollback <app-id> <release-id>
userland apps list
userland apps unpublish <app-id> --yes
```

## Validation checklist

- Authentication is available from `USERLAND_API_KEY` or saved CLI credentials.
- Required secrets are set.
- Activation status is reported.
- Rollback release id is recorded.

## Safety rules

- Do not print API keys or secret values.
- Pass secret values and API keys on stdin (as in the commands above), not with `--value` or `--api-key`, so they stay out of shell history, process lists, and transcripts.
- Do not commit `.env` files. Publishing a folder leaves out dotfiles such as `.env`, `.npmrc`, and `.git/`, refuses private keys, and never follows symlinks; if the CLI reports `dotfiles_skipped`, `symlink`, or `private_key`, publish a build folder rather than working around it.
- Always pass a non-empty `--app <app-id>` when updating an app; without `--app` the CLI creates a new app.
- Unpublish only apps the user named or confirmed. Unpublishing takes the app offline and removes its slugs and custom domains, so check each app id and name with `userland apps list` and show the user the list before running `userland apps unpublish <app-id> --yes`. Without a terminal the command needs `--yes`; piping `y` does not confirm.
- Do not commit `~/.userland` credential files.
- Do not publish app aliases.
- Use app origins for validation.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

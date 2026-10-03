---
name: userland-publish-operate
description: Userland app publish, secrets, events, releases, rollback, invites, and unpublish (remove app) operations.
---

# Userland publish and operate

Userland API version: v0

Use this skill when publishing, updating, inspecting, rolling back, or unpublishing a Userland app, or inviting people to sign in to one.

## Inputs

- Valid app bundle directory.
- Userland CLI installed as `@userland.fun/cli`.
- `USERLAND_API_KEY` in the environment or an API key saved by the CLI.
- Optional `app_id` for updates.
- The names of the secrets the app requires. The owner adds values that are theirs, such as a Stripe or model-provider key, in the console.

## Outputs

- Published release or operation result.
- App origin, release id, activation status, and rollback command.

## Steps

1. Validate catalog, skills, and manifests.
2. For each required secret whose value is the owner's, send the owner `https://console.userland.fun/apps/<app-id>/settings?add-key=<NAME>` instead of asking for the value in chat. They paste it into the console and save it there, so it never passes through the chat. Set a value yourself with `apps secrets set` only when you already have it, or when the console says it can't save keys right now.
3. Publish a new app or update an existing app.
4. Inspect releases and events after publishing.
5. Roll back if activation or runtime behavior is wrong.
6. Unpublish test or demo apps the user no longer needs, only when the user asks.
7. When the user asks, invite people to sign in to an app that has sign-in, or delete a secret the app no longer uses.

## Commands

```sh
userland auth status
userland apps publish examples/<example-slug>
userland apps publish examples/<example-slug> --app <app-id>
userland apps secrets list <app-id>
printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>
userland apps secrets delete <app-id> <NAME> --yes [--account <account-id>]
userland apps releases <app-id>
userland apps events <app-id> --severity error --limit 25
userland apps events <app-id> --severity error --limit 25 --cursor <cursor>
userland apps rollback <app-id> <release-id>
userland apps list [--account <account-id>]
userland apps unpublish <app-id> --yes [--account <account-id>]
userland apps invites create <app-id> --email <email> [--role <role>]... [--expires-in-days <1-30>] [--account <account-id>]
```

If `secrets list`, `secrets delete`, `invites create`, or `--cursor` is not found, update the CLI first: `npm install -g @userland.fun/cli`.

`apps events` prints the newest events first. When there are more, the last line is `cursor=<cursor>`; run the same command again with `--cursor <cursor>` to read the next, older page.

## Validation checklist

- Authentication is available from `USERLAND_API_KEY` or saved CLI credentials.
- Required secrets are set (`userland apps secrets list <app-id>`). If activation is `pending_secrets`, send the `?add-key=<NAME>` link for each missing secret, and publish again with `--app <app-id>` once the owner says it's saved.
- Activation status is reported.
- Rollback release id is recorded.
- An app that the user's website embeds keeps its `runtime.embed_origins` in every release. The list belongs to the release: publishing without it stops the embed, and a rollback brings back the list of the release rolled back to.

## Safety rules

- Do not ask the owner to paste a key into the chat when the `?add-key=` link can take it. Do not print API keys or secret values. To check which secrets are set, use `userland apps secrets list <app-id>`, which shows only names and dates.
- Pass secret values and API keys on stdin (as in the commands above), not with `--value` or `--api-key`, so they stay out of shell history, process lists, and transcripts.
- Do not commit `.env` files. Publishing a folder leaves out dotfiles such as `.env`, `.npmrc`, and `.git/`, refuses private keys, and never follows symlinks; if the CLI reports `dotfiles_skipped`, `symlink`, or `private_key`, publish a build folder rather than working around it.
- Always pass a non-empty `--app <app-id>` when updating an app; without `--app` the CLI creates a new app.
- Unpublish only apps the user named or confirmed. Unpublishing takes the app offline and removes its slugs and custom domains, so check each app id and name with `userland apps list` and show the user the list before running `userland apps unpublish <app-id> --yes`. Without a terminal the command needs `--yes`; piping `y` does not confirm. If the user has more than one account, pass the same `--account <account-id>` to `apps list` and `apps unpublish`, so an app that belongs to another account is not removed.
- Delete a secret only when the user asks. First check that the app's code no longer reads it and remove it from `resources.secrets.required`, or the next release you publish does not go live (`pending_secrets`) until the secret is set and you publish again. Without a terminal, `userland apps secrets delete` needs `--yes`. If the user has more than one account, pass `--account <account-id>`, so a secret of an app in another account is not deleted.
- Invite people with `userland apps invites create`, not a new API key: it works with the key saved by `userland login`. Pass `--role` once for each role the manifest declares, and no `--role` for no special role. If the user has more than one account, pass `--account <account-id>`, so no invite is made for an app in another account. The link lets whoever has it set the person's password once, so give it only to the user who asked, and do not log it or commit it. An invite is only for someone who has no account in the app yet: for an email that already has one, setting the password fails with `409 user_exists` and gives no new role, and there is no command yet to change an existing person's roles, so tell the user that instead of sending an invite.
- Do not commit `~/.userland` credential files.
- Do not publish app aliases.
- Use app origins for validation.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

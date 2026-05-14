# Userland CLI

This directory is the source for the public `@userland.fun/cli` npm package.

Docs:

- https://docs.userland.fun/llms.txt
- https://docs.userland.fun/reference/cli
- https://docs.userland.fun/guides/troubleshooting

Install globally:

```sh
npm install -g @userland.fun/cli
```

Then run:

```sh
userland signup --username <username>
userland login --username <username>
userland auth status
userland auth save-key --username <username> --api-key <api-key>
userland accounts list
userland accounts use <account-id>
userland accounts status --account <account-id>
userland accounts limits --account <account-id>
userland accounts downgrade preview --to free --account <account-id>
userland apps publish examples/<example-slug>
userland apps publish examples/<example-slug> --account <account-id>
userland apps list
USERLAND_ACCOUNT_ID=<account-id> userland apps list
userland apps status <app-id>
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
userland apps secrets set <app-id> <NAME> --value <value>
userland apps events <app-id>
userland apps routes list <app-id>
userland apps slugs add <app-id> <slug>
userland apps domains add <app-id> <hostname>
userland apps domains verify <app-id> <hostname>
```

From this repo, the same commands can be run from source:

```sh
npm run userland -- signup --username <username>
npm run userland -- login --username <username>
npm run userland -- auth status
npm run userland -- auth save-key --username <username> --api-key <api-key>
npm run userland -- accounts list
npm run userland -- accounts use <account-id>
npm run userland -- accounts status --account <account-id>
npm run userland -- accounts limits --account <account-id>
npm run userland -- accounts downgrade preview --to free --account <account-id>
npm run userland -- apps publish examples/<example-slug>
npm run userland -- apps publish examples/<example-slug> --account <account-id>
npm run userland -- apps list
npm run userland -- apps list --account <account-id>
npm run userland -- apps status <app-id>
npm run userland -- apps releases <app-id>
npm run userland -- apps rollback <app-id> <release-id>
npm run userland -- apps secrets set <app-id> <NAME> --value <value>
npm run userland -- apps events <app-id>
npm run userland -- apps routes list <app-id>
npm run userland -- apps slugs add <app-id> <slug>
npm run userland -- apps domains add <app-id> <hostname>
npm run userland -- apps domains verify <app-id> <hostname>
```

`signup`, `login`, and `auth save-key` save the API key to `~/.userland/credentials.json` with `0600` permissions. Account username and password are stored in the OS keychain: macOS Keychain, Windows Credential Manager, or Linux Secret Service through `secret-tool`. App commands prefer `USERLAND_API_KEY` when it is set, then fall back to the saved API key.

Most users do not need to select an account. If no account is selected, the API uses the actor's default account. Team, client, and agency workflows can select an account with `--account <account-id>`, `USERLAND_ACCOUNT_ID`, or `userland accounts use <account-id>`. Platform account members manage apps, releases, secrets, billing, and settings; they are separate from app users inside a published app.

Status and limits:

```sh
userland accounts status --account <account-id>
userland accounts limits --account <account-id>
userland accounts downgrade preview --to starter --account <account-id>
userland apps status <app-id> --account <account-id>
```

Route management:

```sh
userland apps routes list <app-id> --account <account-id>
userland apps slugs list <app-id> --account <account-id>
userland apps slugs add <app-id> <slug> --account <account-id>
userland apps slugs remove <app-id> <slug> --account <account-id>
userland apps domains list <app-id> --account <account-id>
userland apps domains add <app-id> <hostname> --account <account-id>
userland apps domains verify <app-id> <hostname> --account <account-id>
userland apps domains remove <app-id> <hostname> --account <account-id>
```

Internal/platform-admin only operations are routed by the CLI but authorized server-side:

```sh
userland ops accounts status <account-id>
userland ops accounts flag <account-id> suspended_abuse --reason "spam"
userland ops accounts clear <account-id> suspended_abuse --reason "reviewed"
userland ops apps status <app-id>
userland ops apps flag <app-id> suspended_security --reason "incident"
userland ops apps clear <app-id> suspended_security --reason "resolved"
userland ops apps takedown <app-id> --reason "legal review"
userland ops routes disable <route-id> --status disabled_abuse --reason "abuse"
userland ops routes enable <route-id> --reason "resolved"
```

Structured API errors keep details on separate lines:

```text
API 402: Monthly request quota exceeded for the current plan.
error=quota_exceeded
metric=requests.monthly.max
plan_key=free
limit=10000
current=10000
upgrade_required=true
```

## Validation

Build and inspect the publish tarball:

```sh
npm run cli:build
npm run cli:pack
```

Run command-level CLI tests against a mocked API:

```sh
npm run cli:test
```

Run the full public repo validation suite:

```sh
npm run typecheck
npm test
```

## Sync and release policy

For launch, this `cli/` directory is the public CLI source of truth for agents and publishes as `@userland.fun/cli`. When changing the CLI:

1. Update `cli/src/index.ts`, this README, and `https://docs.userland.fun/reference/cli` together.
2. Add or update mocked command tests in `cli/tests`.
3. Run `npm run typecheck`, `npm run cli:test`, and `npm test`.
4. Update the public repo changelog and the docs changelog.

Compatibility:

| CLI package | API version | Distribution |
|---|---|---|
| `@userland.fun/cli` | Userland API v0 | `npm install -g @userland.fun/cli` |

Do not commit API keys or app secrets.

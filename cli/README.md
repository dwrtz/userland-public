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
userland apps publish examples/<example-slug>
userland apps list
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
userland apps secrets set <app-id> <NAME> --value <value>
userland apps events <app-id>
```

From this repo, the same commands can be run from source:

```sh
npm run userland -- signup --username <username>
npm run userland -- login --username <username>
npm run userland -- auth status
npm run userland -- auth save-key --username <username> --api-key <api-key>
npm run userland -- apps publish examples/<example-slug>
npm run userland -- apps list
npm run userland -- apps releases <app-id>
npm run userland -- apps rollback <app-id> <release-id>
npm run userland -- apps secrets set <app-id> <NAME> --value <value>
npm run userland -- apps events <app-id>
```

`signup`, `login`, and `auth save-key` save the API key to `~/.userland/credentials.json` with `0600` permissions. Account username and password are stored in the OS keychain: macOS Keychain, Windows Credential Manager, or Linux Secret Service through `secret-tool`. App commands prefer `USERLAND_API_KEY` when it is set, then fall back to the saved API key.

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

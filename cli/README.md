# Userland CLI

This directory is the public source path for the Userland CLI while npm publishing is deferred.

Docs:

- https://docs.userland.fun/llms.txt
- https://docs.userland.fun/reference/cli
- https://docs.userland.fun/guides/troubleshooting

Run from the repo root:

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/<example-slug>
USERLAND_API_KEY=... npm run userland -- apps list
USERLAND_API_KEY=... npm run userland -- apps releases <app-id>
USERLAND_API_KEY=... npm run userland -- apps rollback <app-id> <release-id>
USERLAND_API_KEY=... npm run userland -- apps secrets set <app-id> <NAME> --value <value>
USERLAND_API_KEY=... npm run userland -- apps events <app-id>
```

## Validation

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

For launch, this `cli/` directory is the public CLI source of truth for agents. Keep `@userland/cli` private until an npm release is intentionally cut. When changing the CLI:

1. Update `cli/src/index.ts`, this README, and `https://docs.userland.fun/reference/cli` together.
2. Add or update mocked command tests in `cli/tests`.
3. Run `npm run typecheck`, `npm run cli:test`, and `npm test`.
4. Update the public repo changelog and the docs changelog.

Compatibility:

| CLI path | API version | Distribution |
|---|---|---|
| `userland-public/cli` | Userland API v0 | Run from source with `npm run userland` |

Do not commit API keys or app secrets.

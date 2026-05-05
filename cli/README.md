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

Do not commit API keys or app secrets.

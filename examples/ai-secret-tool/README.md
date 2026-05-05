# AI Secret Tool

Server-only secret access pattern for calling a model provider without exposing API keys.

This example uses a mock model call by default. Replace `callMockModel` with a real provider call in `server/index.js`.

## Required secret

```sh
USERLAND_API_KEY=... npm run userland -- apps secrets set <app-id> MODEL_API_KEY --value <value>
```

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/ai-secret-tool
```

The frontend must call `/api/run`; it should never receive or store `MODEL_API_KEY`.


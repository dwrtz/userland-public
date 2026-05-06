# AI Secret Tool

Server-only secret access pattern for calling a model provider without exposing API keys.

This example uses a mock model call by default. Replace `callMockModel` with a real provider call in `server/index.js`.

## Required secret

```sh
userland apps secrets set <app-id> MODEL_API_KEY --value <value>
```

## Publish

```sh
userland apps publish examples/ai-secret-tool
```

The frontend must call `/api/run`; it should never receive or store `MODEL_API_KEY`.

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting

Capability docs:

- Secrets: https://docs.userland.fun/guides/secrets

# Server Notes

Dynamic notes app with server routes, `ctx.data`, and runtime logs.

Relevant skills:

- `.agents/skills/userland-runtime-code`
- `.agents/skills/userland-publish-operate`

## Publish

```sh
npm run userland -- apps publish examples/server-notes
```

## Verify

```sh
curl <origin>/api/notes
```

Expected activation status is `live`.

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting

Capability docs:

- Data: https://docs.userland.fun/guides/data

# Blog CMS

Admin-authored blog with app users, durable post data, public post pages, and media uploads.

## Capabilities

- Server runtime routes.
- App-user auth with an `admin` role.
- Data collection named `posts`.
- Public file store named `media`.

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/blog-cms
```

After publishing, create or invite an admin user according to the auth docs before using protected write routes.

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting

Capability docs:

- Auth: https://docs.userland.fun/guides/auth
- Data: https://docs.userland.fun/guides/data
- Files: https://docs.userland.fun/guides/files

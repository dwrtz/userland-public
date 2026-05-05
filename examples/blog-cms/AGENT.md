# Agent notes

Goal: adapt a blog or lightweight CMS pattern.

Inputs:

- Content model.
- Admin role needs.
- Optional file upload needs.

Outputs:

- Manifest with `auth`, `data.posts`, and `files.media`.
- Static editor under `public/`.
- Server routes in `server/index.js`.

Steps:

1. Rename app metadata and tags.
2. Adjust `posts` fields and indexes for the target content type.
3. Keep protected writes behind `ctx.auth.requireRole(request, "admin")`.
4. Keep public reads limited to published content.
5. Validate with `npm run validate:manifests`.

Safety:

- Do not expose `USERLAND_API_KEY`.
- Do not expose admin-only data from public routes.
- Do not accept arbitrary upload types without updating the file store policy.

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

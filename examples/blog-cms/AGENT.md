# Agent notes

Goal: adapt a blog or lightweight CMS pattern.

Plan: `required_plan` is `free`; `paid_features` is `[]`. The manifest is at or under every Free manifest limit: one role, one collection, one index, one public file store, and a `max_file_size_bytes` of exactly 5 MB. Any of these changes needs a paid plan: `public_signup: true`, a private file store (`public: false`), a larger upload limit, a second file store, or more than two indexes on `posts`. Update `required_plan` and `paid_features` in `example.json` and `catalog.json` if you make one.

Inputs:

- Content model.
- Admin role needs.
- Optional file upload needs.

Outputs:

- Manifest with `auth`, `data.collections.posts`, and `files.stores.media`.
- Static editor under `public/`.
- Server routes in `server/index.js`.

Steps:

1. Rename app metadata and tags.
2. Adjust `posts` fields. Every field used in a `list` `where` or `order_by` must appear in an index; the `by_status` index covers `status` and `published_at`. The runtime rejects queries on fields that are not indexed, and on `created_at` or `updated_at`.
3. Keep admin checks in app code: `ctx.auth.currentUser(request)` then `user.roles.includes("admin")`, returning `401` or `403`. Left uncaught, a `ctx.auth.requireUser` or `ctx.auth.requireRole` error returns a plain `401` or `403`; catch it when you want a redirect or a friendlier page.
4. Keep the same-origin check (`isSameOrigin`) in front of every POST, and keep `readJson` requiring `content-type: application/json`. The sign-in cookie is SameSite=Lax and every `*.apps.userland.fun` app is the same site, so without the check a page on another app could auto-submit a hidden `text/plain` form that creates, publishes, or uploads as a signed-in admin. The check rejects any `Origin` other than the app's own (including `null`) and `Sec-Fetch-Site` values other than `same-origin`/`none`.
5. Keep public reads limited to published posts, and escape post content in server-rendered HTML. `?status=draft` is admin-only and sent with `cache-control: no-store`.
6. Keep lists paginated: `GET /api/posts` returns one page of 20 plus a `cursor` when more exist, and the page's "Show more" buttons pass it back. Do not raise `limit` to hide pagination; it tops out at 100.
7. The editor in `public/assets/app.js` reads `/_userland/auth/session` and shows itself only when `user.roles` includes `admin`; signed-out visitors get a link to `/_userland/auth/login?return_to=/`. The server checks the role again on every request.
8. Validate: `npm run validate:manifests -- blog-cms` and `npx vitest run examples/blog-cms`.
9. After publishing, invite the first admin with `POST /v0/apps/:app_id/admin-invites` (Auth guide).

Safety:

- Do not expose `USERLAND_API_KEY`.
- Do not expose draft posts or admin-only data from public routes.
- Do not accept arbitrary upload types without updating `allowed_content_types`.
- Do not remove the same-origin check or accept non-JSON bodies on the JSON routes.

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Plan limits: https://docs.userland.fun/reference/limits

Capability docs:

- Auth: https://docs.userland.fun/guides/auth
- Data: https://docs.userland.fun/guides/data
- Files: https://docs.userland.fun/guides/files
- Rollback: https://docs.userland.fun/guides/rollback

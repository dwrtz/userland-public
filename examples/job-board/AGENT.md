# Agent notes

Goal: adapt a niche job board or listing directory with public listings, filters, a submission form, and an owner review queue.

Inputs:

- The community the board serves, its name, and its look (colors, fonts, logo).
- Categories and schedules (or other filters) for listings.
- Listing fields, and which ones are public versus owner-only.
- Who reviews submissions (the `owner` role) and how people apply.

Outputs:

- Manifest with `auth` (role `owner`, `public_signup: false`) and a `listings` collection.
- Server routes in `server/index.js`, rules in `server/listings.js`, templates in `server/views.js`.
- Static styles, fonts, and favicon under `public/`.
- Tests in `tests/job-board.test.ts`.

Steps:

1. Remove demo mode first: delete `server/demo.js`, the `demoMode` import in `server/index.js`, the `demo-listings` collection in the manifest, and the "public demo" tests. Change the last line of `server/index.js` to `export default createApp();`.
2. Rename the app in the manifest, then update `BRAND` in `server/views.js`, the tokens at the top of `public/assets/loamwork.css`, the `LOGO` SVG, and `public/favicon.svg`.
3. Change `CATEGORIES` and `JOB_TYPES` in `server/listings.js`. They are validated in code, so no data migration is needed.
4. To add a listing field: declare it in the manifest, add limits in `FIELD_LIMITS`, copy it in `toListing`, add it to the form in `listingFields`, and add it to `PRIVATE_FIELDS` if the public must not see it.
5. Keep every `where` and `order_by` field inside a declared index. The Free plan allows 2 indexes per collection and 2 collections.
6. Test with `npx vitest run examples/job-board`.
7. Publish with `userland apps publish <dir> --message "..."`, record the app ID and release ID in the README, then create an owner invite with `POST /v0/apps/:app_id/admin-invites` and `{"email": "...", "roles": ["owner"]}`.

Safety:

- Keep the owner gate (`ownerAccess` in `server/index.js`) in front of every `/owner` route, including POST routes.
- Keep the same-origin check (`isSameOrigin`) on every POST. The sign-in cookie is SameSite=Lax and all `*.apps.userland.fun` apps are same-site, so this is what stops another app's page from posting owner actions.
- Keep `access.read` and `access.write` at `server_only` so contact details are only reachable through server code.
- Render visitor text only through the `html` tag in `server/views.js`, which escapes it. Use `raw()` only for markup you wrote.
- Keep contact email, private notes, and history out of public pages (`publicListing()` strips them).
- Keep the honeypot field and length limits on public forms.
- Do not log contact details with `ctx.log`; log listing IDs.
- Do not put API keys or `USERLAND_API_KEY` in `public/` or server code.

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
- App Analytics: https://docs.userland.fun/guides/app-analytics
- Rollback: https://docs.userland.fun/guides/rollback

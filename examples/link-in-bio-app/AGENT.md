# Agent notes

Goal: adapt a creator link-in-bio page with featured products, an email-list signup, a contact form, and an owner view for links and messages.

Plan: `required_plan` is `free`; `paid_features` is `[]`. App-user auth with one role (`owner`, no public signup), two collections with one index each, no files, secrets, jobs, or webhooks. A custom domain is a Starter feature set up after publishing; it does not change the manifest.

Inputs:

- The creator's name, bio, social profiles, and starter links (`server/content.js`).
- Brand colors and fonts (`public/assets/site.css`).
- The logo or profile photo (`logoMark()` in `server/views.js`; put a photo in `public/img/`).
- Contact topics and email-list wording (`server/content.js`).
- The owner's email for the admin invite.

Outputs:

- Manifest with `auth` (role `owner`) and the `links` and `inbox` collections.
- Server-rendered pages in `server/views.js`; routes and the owner gate in `server/index.js`.
- Tests in `tests/` that cover forms, escaping, the owner gate, and removing demo mode (`tests/demo.test.ts` covers demo privacy and is deleted with `server/demo.js`).

Steps:

1. Ask the owner for their business details, then edit `server/content.js`. Keep example.com addresses out of a real launch.
2. Restyle with the `:root` tokens in `public/assets/site.css`. Keep fonts self-hosted; no CDN links or remote scripts.
3. Keep every `/admin` route behind `requireOwner` in `server/index.js`, which uses `ctx.auth.currentUser` and `ctx.auth.requireRole(request, "owner")`. In the deployed runtime these helpers throw plain errors, so catch them and return a redirect or 403 instead of letting the request fail.
4. Only filter on indexed, declared fields. `where` is exact-match only; sort in code (`server/store.js`). Stay at two collections and two indexes per collection to keep the Free plan.
5. Escape every value from visitors or the database with `escapeHtml` in `server/views.js`. Keep the honeypot field and length limits on public forms.
6. Unless the app is a public demo, delete `server/demo.js` and `tests/demo.test.ts`, then delete every line in `server/index.js` that ends with `// demo` (see README "Demo mode"). Keep the `demo_key` field; real rows use `""`. The "removing demo mode" test runs these steps on a copy. Demo mode only turns on for the hostnames in `DEMO_HOSTS`.
7. Validate: `npm run validate:manifests` and `npx vitest run examples/link-in-bio-app`.
8. Publish with `userland apps publish <dir>`, invite the owner (`POST /v0/apps/:app_id/admin-invites` with `"roles":["owner"]`), and tell the owner to click "Add starter links" in the owner view. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). The invite call needs an API key in `USERLAND_API_KEY`, but `userland login` saves its key to `~/.userland/credentials.json`, not the environment: have the owner run `userland auth api-keys create --name "owner invite"` and export the printed key and the app id in their own terminal (README.md shows the commands), then unset and revoke that key once they have signed in.

Safety:

- Do not put `USERLAND_API_KEY` or any secret in `public/`.
- Do not show email addresses or messages on public routes.
- Userland strips ordinary cookies before app code runs; only `__Host-ul_session` reaches the server. Do not build features on custom cookies.
- Do not log message bodies or email addresses.

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
- Rollback: https://docs.userland.fun/guides/rollback

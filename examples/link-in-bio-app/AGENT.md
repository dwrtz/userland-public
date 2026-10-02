# Agent notes

Goal: adapt a creator link-in-bio page with featured products, an email-list signup, a contact form, and an owner view for links and messages.

Plan: `required_plan` is `free`; `paid_features` is `[]`. App-user auth with one role (`owner`, no public signup), two collections with two indexes each (the Free maximum), no files, secrets, jobs, or webhooks. Free saves 1,000 items per account; links, messages, signups, and tap-count rows share it. A custom domain is a Starter feature set up after publishing; it does not change the manifest.

Inputs:

- The creator's name, bio, social profiles, and starter links (`server/content.js`).
- Brand colors and fonts (`public/assets/site.css`).
- The logo or profile photo (`logoMark()` in `server/views.js`; put a photo in `public/img/`).
- Contact topics and email-list wording (`server/content.js`).
- The owner's email for the admin invite.

Outputs:

- Manifest with `auth` (role `owner`) and the `links` and `inbox` collections.
- Server-rendered pages in `server/views.js`; routes and the owner gate in `server/index.js`.
- Tests in `tests/` that cover forms, form limits, escaping, the owner gate, tap counting under load, paging, and removing demo mode (`tests/demo.test.ts` covers demo privacy and is deleted with `server/demo.js`). Tests run on the shared runtime harness built from the manifest, so undeclared fields and unindexed queries fail in tests too. `tests/helpers.ts` reports unique clashes with Userland's `unique_conflict` code and makes every data call yield so `Promise.all` requests interleave.

Steps:

1. Ask the owner for their business details, then edit `server/content.js`. Keep example.com addresses out of a real launch.
2. Restyle with the `:root` tokens in `public/assets/site.css`. Keep fonts self-hosted; no CDN links or remote scripts.
3. Keep every `/admin` route behind `requireOwner` in `server/index.js`, which uses `ctx.auth.currentUser` and `ctx.auth.requireRole(request, "owner")`. Left uncaught, these helpers return a plain `401` or `403`, so `requireOwner` catches them to redirect to sign-in or show a friendlier page. It also refuses owner changes whose `Origin` isn't this app's own origin (including other `*.apps.userland.fun` apps, which count as the same site for cookies, and `Origin: null`); keep that check on any new owner form.
4. Only filter or sort on indexed, declared fields; `where` is exact-match only. Both collections already use the Free plan's two indexes: `by_scope`/`by_scope_status` for lists and a unique `slot` for anything that must not be duplicated when two requests arrive together (one signup per address, per-address daily note limit, starter links, tap counts, demo visitor numbers). Reuse `slot` with a new prefix instead of adding an index, and save slotted rows with `claimSlot` in `server/store.js`. Userland saves a row and its unique values together, so when two creates with the same slot arrive at once exactly one is kept and the other throws `unique_conflict` and saves nothing; `claimSlot` turns that into `null`. `ctx.data.transaction` does not make separate requests wait for each other. Limits that count rows (unread messages, signups per day) count before saving and again after, and remove the new row when the second count is over the limit, so a burst can't slip past them. Inbox tabs read one page at a time with a cursor; don't load whole lists on a page.
5. Escape every value from visitors or the database with `escapeHtml` in `server/views.js`. Keep the honeypot field, length limits, and the limits at the top of `server/store.js` on public forms. Tap counts live in their own rows (`recordTap`), never on the link row the owner edits.
6. Unless the app is a public demo, delete `server/demo.js` and `tests/demo.test.ts`, then delete every line in `server/index.js` that ends with `// demo` (see README "Demo mode"). Keep the `demo_key` field; real rows use `""`. The "removing demo mode" test runs these steps on a copy. Demo mode only turns on for the hostnames in `DEMO_HOSTS`.
7. Validate: `npm run validate:manifests` and `npx vitest run examples/link-in-bio-app`.
8. Publish with `userland apps publish <dir>`, invite the owner with `userland apps invites create <app-id> --email <owner email> --role owner`, and tell the owner to click "Add starter links" in the owner view. Give the link it prints only to the owner, and don't log it or commit it. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). `apps invites create` needs CLI 0.9.0 or later (if the CLI doesn't know it, run `npm install -g @userland.fun/cli@latest`) and uses the key saved by `userland login`, so don't make an API key for the invite.

Safety:

- Do not put `USERLAND_API_KEY` or any secret in `public/`.
- Do not show email addresses or messages on public routes.
- Userland strips ordinary cookies before app code runs; only `__Host-ul_session` reaches the server. Do not build features on custom cookies.
- Do not log message bodies or email addresses.
- The email list is unconfirmed; tell the owner to import it with double opt-in. Removed addresses must stay removed when someone signs them up again.

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

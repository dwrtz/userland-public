# Agent notes

Goal: adapt a quote and invoice app for a service business: a public quote request form, private client links for quotes and invoices, and an owner-only desk.

Inputs:

- Business details: name, address, email, currency, locale, time zone, tax default, payment terms, document numbering (`server/studio.js`).
- Services offered on the public page and in the request form.
- Document statuses the business needs (default: quote requested, draft, sent, accepted, declined, invoiced; invoice draft, sent, paid, void).
- Whether the owner wants the public demo behavior (almost always: no).

Outputs:

- Manifest with `auth` (`app_users`, role `owner`, no public signup) and two data collections, `clients` and `documents`. Required plan: Free.
- Server routes in `server/index.js`, data and money rules in `server/store.js`, HTML in `server/views.js`.
- Static assets in `public/` (CSS, a small progressive script, self-hosted font).

Steps:

1. Edit `server/studio.js` first. Keep money in integer cents.
2. Remove demo mode unless the owner wants a public demo: delete `server/demo.js`, delete every line ending in `// demo` in `server/index.js`, and delete the `jobs` section in the manifest. Keep the `workspace` field; real data uses `main`. The "removing demo mode" test runs these steps on a copy, so run the tests afterwards.
3. Keep every `/desk` route behind `ownerGate`, which calls `ctx.auth.requireRole(request, "owner")`. Never add an admin route that skips it.
4. Change fields in `manifest.userland.json` and `server/store.js` together. `where` and `order_by` fields must be in an index. The Free plan allows two collections with two indexes each; keep line items in the `json` field instead of adding a third collection.
5. Keep status changes inside `TRANSITIONS` and conversions inside `ctx.data.transaction`.
6. Run `npx vitest run examples/invoice-generator` (update tests when you change routes or rules).
7. Publish with `userland apps publish <dir> --message "..."`, then invite the owner with `POST /v0/apps/:app_id/admin-invites` and `{"roles":["owner"]}`. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). The invite call needs an API key in `USERLAND_API_KEY`, but `userland login` saves its key to `~/.userland/credentials.json`, not the environment: have the owner run `userland auth api-keys create --name "owner invite"` and export the printed key and the app id in their own terminal (README.md shows the commands), then unset and revoke that key once they have signed in.
8. Tell the owner the link, how to sign in, that it runs on Free, and how to roll back (`userland apps releases`, `userland apps rollback`).

Safety:

- Escape every value with `esc()` in views. Don't build HTML from unescaped input.
- Don't show drafts or requests through `/p/:token`; `getDocumentByToken` filters them.
- Log ids and document numbers only; never log client names or emails.
- Keep payment or email API keys in app secrets and read them only in server code with `ctx.secrets`. Nothing secret goes in `public/`.
- App code only receives Userland's own sign-in cookie. Don't rely on your own cookies for identity or sessions.

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
- Jobs: https://docs.userland.fun/guides/jobs
- Secrets: https://docs.userland.fun/guides/secrets
- Rollback: https://docs.userland.fun/guides/rollback

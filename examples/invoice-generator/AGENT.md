# Agent notes

Goal: adapt a quote and invoice app for a service business: a public quote request form, private client links for quotes and invoices, and an owner-only desk.

Inputs:

- Business details: name, address, email, currency, locale, time zone, tax default, payment terms, document numbering (`server/studio.js`).
- Services offered on the public page and in the request form.
- Document statuses the business needs (default: quote requested, draft, sent, accepted, declined, invoiced; invoice draft, sent, paid, void).
- Whether the owner wants the public demo behavior (almost always: no).

Outputs:

- Manifest with `auth` (`app_users`, role `owner`, no public signup) and two data collections, `clients` and `documents`, with two indexes each. Required plan: Free.
- Server routes in `server/index.js`, data and money rules in `server/store.js`, HTML in `server/views.js`.
- Static assets in `public/` (CSS, a small progressive script, self-hosted font).

Steps:

1. Edit `server/studio.js` first. Keep money in integer cents.
2. Remove demo mode unless the owner wants a public demo: delete `server/demo.js` and `tests/demo.test.ts`, delete every line ending in `// demo` in `server/index.js`, and delete the `jobs` section in the manifest. Keep the `workspace` field; real data uses `main`. The "removing demo mode" test runs these steps on a copy, so run the tests afterwards.
3. Keep every `/desk` route behind `ownerGate`, which calls `ctx.auth.requireRole(request, "owner")`. Never add an admin route that skips it.
4. Change fields in `manifest.userland.json` and `server/store.js` together. `where` and `order_by` fields must be in an index (`documents.for_lists` holds the fields the desk filters and sorts on). The Free plan allows two collections with two indexes each, and both collections use both; keep line items in the `json` field instead of adding a third collection, and add new list fields to `for_lists` instead of a new index.
5. Keep status changes inside `TRANSITIONS`. Rules that must hold when two requests arrive together (one client per email, one document per number, one invoice per quote) come from the unique indexes `clients.by_email` and `documents.by_number`: catch `unique_conflict` (see `isUniqueConflict`) instead of checking first. `ctx.data.transaction` doesn't serialize requests, so don't rely on it for this.
6. Never read only the first page of a list: use `listEvery` for totals and `listPage` (50 rows plus a link to the next page) for tables in `server/store.js`. `where` matches exact values only; to leave some rows out of a table, pass `listPage` a `keep` test (as the Quotes tab does for new requests) so pages still fill up.
7. Run `npx vitest run examples/invoice-generator` (update tests when you change routes or rules).
8. Publish with `userland apps publish <dir> --message "..."`, then invite the owner with `POST /v0/apps/:app_id/admin-invites` and `{"email":"<owner email>","roles":["owner"]}`. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). The invite call needs an API key in `USERLAND_API_KEY`, but `userland login` saves its key to `~/.userland/credentials.json`, not the environment: have the owner run `userland auth api-keys create --name "owner invite"` and export the printed key and the app id in their own terminal (README.md shows the commands), then unset and revoke that key once they have signed in.
9. Tell the owner the link, how to sign in, that it runs on Free, and how to roll back (`userland apps releases`, `userland apps rollback`).

Safety:

- Escape every value with `esc()` in views. Don't build HTML from unescaped input.
- Don't show drafts or requests through `/p/:token`; `getDocumentByToken` filters them.
- Every form post goes through `readForm`, which refuses posts whose `Origin` isn't this app's own origin (other `*.apps.userland.fun` apps and `null` included) and bodies over 64 KB.
- Keep the public form's caps (`LIMITS.pendingRequests`, `LIMITS.requestsPerClient`) so a bot can't fill the Free plan's 1,000 rows. A count taken before saving misses requests saved at the same moment, so `createRequest` counts again after saving and removes what it added when it went over; keep that pattern for any new cap.
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

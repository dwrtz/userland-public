# Agent notes

Goal: adapt a pre-launch waitlist with referral positions, optional questions, and an owner view.

Inputs:

- Product name, one-line pitch, launch timing, and brand colors.
- What to ask people after they join (keep it to two or three optional questions).
- Referral reward (places moved up per friend).
- Owner email for the `owner` invite.

Outputs:

- Manifest with `auth` (`owner` role, no public signup) and the `signups` collection.
- Server routes in `server/index.js`; rules in `server/waitlist.js`; HTML in `server/views.js`.
- Brand tokens and fonts in `public/`.

Steps:

1. Rename the app in `manifest.userland.json` and replace the Velto copy, logo, and color tokens.
2. Remove demo mode unless the user wants a public demo: delete `server/demo.js` and `tests/demo.test.ts`, delete every line ending in `// demo` in `server/index.js`, and delete the `demo-signups` collection. The "removing demo mode" test runs these steps on a copy, so run the tests afterwards.
3. Edit `QUESTIONS` in `server/waitlist.js`. Store keys, show labels, and drop unknown answers.
4. Keep every owner route behind `requireOwner()`, which calls `ctx.auth.requireRole(request, "owner")`.
5. Query only indexed fields in `where` (`email`, `referral_code`), and page with `limit` of at most 100. Filter and sort the rest in code.
6. Validate with `npm run validate:manifests` and test with `npx vitest run examples/waitlist-app`.
7. Publish, then create the owner invite with `POST /v0/apps/:app_id/admin-invites` and `{"email":"<owner email>","roles":["owner"]}`. Keep the API key on the owner's machine. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). The invite call needs an API key in `USERLAND_API_KEY`, but `userland login` saves its key to `~/.userland/credentials.json`, not the environment: have the owner run `userland auth api-keys create --name "owner invite"` and export the printed key and the app id in their own terminal (README.md shows the commands), then unset and revoke that key once they have signed in.
8. Tell the owner the link, the Free plan fit and its limits (1,000 rows per app, 10,000 requests a month across all the account's apps, 10 ms of compute per request), and how to roll back.

Safety:

- Do not add an open admin route. Signed out redirects to `/_userland/auth/login`; signed in without the role gets `403`.
- Do not show one person's details to another. Private pages use an unguessable token in the link.
- Keep the honeypot field, the length limits, and `escapeHtml()` on every value in HTML.
- Keep the neutral `/thanks` answer for repeat emails; an "already on the list" error lets anyone check who signed up.
- If you keep a public demo, keep its cleanup: `demo_expires_at`, `sweepExpired()`, and the per-visitor and demo-wide limits in `server/demo.js`.
- Keep the CSV formula guard in `toCsv()`.
- Do not log emails or names with `ctx.log`; log ids only.
- Do not expect ordinary browser cookies in server code. Userland passes only its own sign-in cookie.
- Do not store a running referral total. `withReferralCounts()` works it out from `referred_by`, so two friends joining at once can't overwrite each other's credit.
- Keep the landing page off the full list (`countJoined()` reads one page). Only the private page and owner view need every row.
- Do not put `USERLAND_API_KEY` or other secrets in `public/`.

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

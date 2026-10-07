# Agent notes

Goal: adapt a pre-launch waitlist with referral positions, optional questions, and an owner view.

Inputs:

- Product name, one-line pitch, launch timing, and brand colors.
- What to ask people after they join (keep it to two or three optional questions).
- Referral reward (places moved up per friend).
- Owner email for the `owner` invite.
- Contact email people can write to when they lose their private link (`BRAND.contactEmail` in `server/views.js`).

Outputs:

- Manifest with `auth` (`owner` role, no public signup) and the `signups` collection.
- Server routes in `server/index.js`; rules in `server/waitlist.js`; HTML in `server/views.js`.
- Brand tokens and fonts in `public/`.

Steps:

1. Rename the app in `manifest.userland.json` and replace the Velto copy, logo, and color tokens.
2. Remove demo mode unless the user wants a public demo: delete `server/demo.js` and `tests/demo.test.ts`, delete every line ending in `// demo` in `server/index.js`, and delete the `demo-signups` collection. Then run the tests; they pass without further changes. The "removing demo mode" tests run these steps on a copy and fail if any test outside `tests/demo.test.ts` depends on the demo, so keep demo-only tests in that file.
3. Edit `QUESTIONS` in `server/waitlist.js`. Store keys, show labels, and drop unknown answers.
4. Keep every owner route behind `requireOwner()` (owner form posts go through `ownerPost()`, which also checks `Origin`). It calls `ctx.auth.currentUser(request)` once, redirects signed-out visitors to sign in, and returns `403` unless `user.roles` includes `owner`; other errors are not caught.
5. Query only indexed fields in `where` (`email`, `referral_code`), and page with `limit` of at most 100. Filter and sort the rest in code.
6. Inside the `userland-public` repo, validate with `npm run validate:manifests` and test with `npx vitest run examples/waitlist-app` (the tests import the repo's `scripts/runtime-harness.ts` and use its vitest globals). In a copy outside the repo, run `userland validate . --plan free --strict`; to keep the tests, install `vitest`, run it with `globals: true`, copy `scripts/runtime-harness.ts` in, and fix the harness import path in both test files.
7. Publish, then create the owner invite with `userland apps invites create <app-id> --email <owner email> --role owner`. Give the link it prints only to the owner, and don't log it or commit it. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). `apps invites create` needs CLI 0.9.0 or later (if the CLI doesn't know it, run `npm install -g @userland.fun/cli@latest`) and uses the key saved by `userland login`, so don't make an API key for the invite.
8. Tell the owner the link, the Free plan fit and its limits (1,000 rows per app, archived people included; 10,000 requests a month across all the account's apps; 10 ms of compute per request), what visitors see when the list is full ("The waitlist is full right now", plus a `waitlist full` error event), how to clean up spam (search, Archive, then Delete from the Archived list), how to give someone a new private link, and how to roll back. The README's Verify step adds a real signup; tell them to use their own email and delete it afterwards.

Safety:

- Do not add an open admin route. Signed out redirects to `/_userland/auth/login`; signed in without the role gets `403`.
- Do not show one person's details to another. Private pages use an unguessable token in the link.
- Keep the honeypot field (`TRAP_FIELD`, hidden with `display: none`; don't rename it to something autofill knows, like `company` or `website`), the length limits, and `escapeHtml()` on every value in HTML.
- Keep the neutral `/thanks` answer for repeat emails; an "already on the list" error lets anyone check who signed up. It does not hide everything: a new email still goes to its private page, and whoever types an email first holds that private link. Don't claim more than that. The owner's **New link** button (`POST /admin/signups/:id/link`) fixes a lost or taken link; emailing the link instead of showing it closes the gap.
- Check `Origin` on every form post (`isSameOrigin()`); other `*.userland.link` apps count as the same site to the browser, so the sign-in cookie alone is not enough.
- Only archived people can be deleted, bulk archive needs a search or filter, and bulk changes stop at `BULK_LIMIT` (50) per click.
- Catch `quota_exceeded` on writes that add rows and show a plain page; never let a raw error reach visitors.
- If you keep a public demo, keep its cleanup: `demo_expires_at`, `sweepExpired()`, and the per-visitor and demo-wide limits in `server/demo.js`.
- Keep the CSV formula guard in `toCsv()`.
- Do not log emails or names with `ctx.log`; log ids only.
- Do not expect ordinary browser cookies in server code. Userland passes only its own sign-in cookie.
- Do not store a running referral total. `withReferralCounts()` works it out from `referred_by`, so two friends joining at once can't overwrite each other's credit. It counts each inbox once (`emailKey()`).
- Read whole lists with `listAll()`, which follows the cursor to the end; never cap a list at some number of rows or pages.
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

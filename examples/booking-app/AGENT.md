# Agent notes

Goal: adapt this lesson booking app for a service business: a public page where customers request a time, and a signed-in owner desk for requests and services.

Inputs:

- Business name, contact email, address or "online only", and brand colors.
- Services with length and price (lessons, sessions, appointments).
- Opening hours, time zone, notice period, and how far ahead people can book.
- The details to collect from customers, and who should sign in as the owner.

Outputs:

- `manifest.userland.json` with `auth` (`owner` role, no public sign-up) and the `services` and `bookings` collections.
- `server/index.js`, `server/views.js`, and `server/schedule.js` adapted to the business.
- `server/demo.js` and `tests/demo.test.ts` removed for a real business, along with every line in `server/index.js` that ends with `// demo`, so demo mode can never turn on.
- Passing tests in `tests/booking-app.test.ts`.

Steps:

1. Ask the owner for the inputs above before changing code. Explain the plan in plain language: pages, who signs in, and what is saved.
2. Demo mode turns on only for hosts in `DEMO_HOSTS` in `server/demo.js`. For a real business, remove it: delete `server/demo.js` and `tests/demo.test.ts`, then delete every line in `server/index.js` that ends with `// demo`. Keep the `demo_*` fields and indexes in the manifest; real rows have `demo_key: ""` and the queries and ownership checks rely on it. The "removing demo mode" test runs these steps on a copy. Everywhere else, `/studio` requires an app user with the `owner` role.
3. Update `STUDIO` in `server/views.js`, `STUDIO_HOURS` in `server/schedule.js`, and `STARTER_SERVICES` in `server/index.js`. Rename "lesson" copy to fit the business.
4. Keep every `where` and `order_by` field listed in a collection index. Userland rejects unindexed queries. Read requests one status at a time (`findBookings`, `upcomingBookings`) and page with `cursor`; never read the whole history into one list, and never stop at a fixed number of rows without offering the next page.
5. Keep the double-booking protection: `takeHolds` creates one hold row per half-hour block (unique `hold` key, `status: "hold"`) before the request is saved, and treats `unique_conflict` as "time taken". `ctx.data.transaction` does not serialize concurrent requests, so it can't do this alone. Release holds on decline, cancel, and delete; take them again on confirm and reopen. Every query for requests must filter on `status` so hold rows never appear as requests.
6. Test with `npx vitest run examples/booking-app` from the repo root.
7. Publish with `userland apps publish <dir> --message "..."`, then create the owner invite with `userland apps invites create <app-id> --email <owner email> --role owner`. Give the link it prints only to the owner, and don't log it or commit it. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). `apps invites create` needs CLI 0.9.0 or later (if the CLI doesn't know it, run `npm install -g @userland.fun/cli@latest`) and uses the key saved by `userland login`, so don't make an API key for the invite.
8. Check `userland apps events "$APP_ID" --severity error` after the first real booking. Record `app_id` and `release_id` in the project README.

Safety:

- Never leave an owner route open. Use `ctx.auth.currentUser(request)` and check for the `owner` role (or `ctx.auth.requireRole`) on every `/studio` route, including POST routes.
- Do not turn on `public_signup`. It is a paid feature and lets anyone create an account.
- Escape every stored or submitted value with `esc()` before it goes into HTML.
- Keep length limits, email checks, the honeypot field, and `REQUEST_LIMITS` on public forms, including the second limit check after a request is saved (it catches requests sent at the same moment). Userland doesn't pass visitor IP addresses to app code.
- Keep the `Origin` check on every POST. Owner routes rely on the sign-in cookie, and every app on apps.userland.fun counts as the same site, so owner posts must carry this host's `Origin` (or `Sec-Fetch-Site: same-origin`); `Origin: null` and other hosts are refused.
- Build `mailto:` links with `encodeURIComponent`, and keep the strict email pattern.
- Tell the owner about the Free plan's 1,000-row limit and the **Clear out** button (README "Spam and storage").
- Log ids and statuses with `ctx.log`, not names, emails, or phone numbers.
- Keep API keys and secrets out of `public/` and out of HTML. Use `ctx.secrets` from server code if you add email or payment services.
- Stay on the Free plan unless the owner agrees to a paid feature (short address, custom domain, traffic analytics, scheduled reminders).

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
- Rollback: https://docs.userland.fun/guides/rollback
- App Analytics: https://docs.userland.fun/guides/app-analytics

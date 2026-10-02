# Agent notes

Goal: adapt a lead inbox and small CRM for a service business: a public request form, and an owner-only board to track each lead from first contact to won or lost.

Inputs:

- The business name, services, and how customers describe their project.
- The stages the owner moves a lead through (default: new, contacted, site visit, quoted, won, lost).
- The fields the owner needs on each lead (default: contact details, project type, budget, timeline, notes, follow-up date).
- Whether the public request form is wanted at all. Some owners only add leads by hand.

Outputs:

- `manifest.userland.json` with `auth` (one `owner` role, no public signup) and two data collections: `leads` and `activity`.
- `server/leads.js` with option lists, validation, and the store that reads and writes `ctx.data`.
- `server/views.js` with server-rendered HTML for every page, and `public/assets/crm.css` for the look.
- `server/index.js` with the routes and the owner gate.
- A short report for the owner: the app link, how to sign in, which plan it needs, and how to roll back.

Steps:

1. Rename the business in `BUSINESS` (`server/views.js`), the copy on the home page, and the brand colors and fonts in `public/assets/crm.css`.
2. Change stages, project types, budgets, or sources in `server/leads.js` and the matching `enum` values in the manifest together. They must match exactly.
3. Keep every owner route behind `requireOwner()` in `server/index.js`. It uses `ctx.auth.currentUser(request)` and checks for the `owner` role, redirecting signed-out visitors to `/_userland/auth/login`.
4. Lead creation and stage changes use `ctx.data.transaction` to group a lead with its history entry. It does not undo the first write if a later one fails and does not serialize simultaneous requests, so never rely on it for an invariant. The pages already handle a lead without its history entry. For count limits like `REQUEST_LIMITS`, check before saving, save, count again with the new row included, and delete it if the count is over, as `createLead()` in `server/leads.js` does; a check before saving alone lets a burst of simultaneous requests through.
5. For a real business, remove the demo code (see below) before the first publish. Demo mode already stays off outside the public demo's addresses, but removing it keeps the owner's app simple and drops the demo-only fields.
6. Validate the manifest with `npm run validate:manifests` and test with `npx vitest run examples/mini-crm`.
7. Publish with `userland apps publish <dir> --message "..."`. Then invite the owner as an app user with the `owner` role: `userland apps invites create <app-id> --email <owner email> --role owner` (see the Auth guide). The invite link lets them set a password and sign in at `/_userland/auth/login`. Give the link it prints only to the owner, and don't log it or commit it. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). `apps invites create` needs CLI 0.9.0 or later (if the CLI doesn't know it, run `npm install -g @userland.fun/cli@latest`) and uses the key saved by `userland login`, so don't make an API key for the invite.
8. Record the app ID and release ID in the project README so later publishes use `--app <app-id>`.

Demo mode:

- `server/demo.js` powers the public demo only, and only turns on for requests to the hostnames in `DEMO_HOSTS` (the public demo's addresses). On any other address the owner routes require a signed-in owner and leads are saved normally. On the demo addresses it lets visitors see the owner side without signing in and keeps each visitor's entries apart with a random key in the page address. Userland forwards only its own sign-in cookie to app code, so the key can't live in a cookie. Anyone with a visitor's link sees that visitor's entries, so the demo copy asks for made-up details; don't reword it into a privacy promise. `DEMO_LIMITS` caps each visitor and the demo as a whole.
- The demo saves only `activity` rows tagged with `demo_visitor` and `demo_saved_at`. `DEMO_LIMITS` caps each visitor (10 leads, 40 entries) and the whole demo (60 entries an hour, counted again after saving like the form's limits), and entries are removed after `DEMO_KEEP_HOURS` (12), a few on each save, so the demo stays under Free's 1,000 rows. The `leads` collection keeps an unused `demo_visitor` field from older versions of the demo.
- To remove it: delete `server/demo.js`, delete the `import { demo } from "./demo.js";` line in `server/index.js`, change the last line to `export default createApp();`, remove the `demo_visitor` field from the `leads` collection and the `demo_visitor` and `demo_saved_at` fields and the `by_demo_visitor` index from the `activity` collection in the manifest (keep `by_lead`), and delete `tests/demo.test.ts`. The "turning demo mode off" tests in `tests/mini-crm.test.ts` run these steps on a copy and then run the copy's remaining tests. Do this before the first publish of a real app. Never remove or retype a field after publishing: Userland won't make that release live. Add a new field instead.

Plan:

- The manifest fits the Free plan: server runtime, app-user auth with one role, two collections, and at most two indexes per collection (`leads` uses both: `by_stage` and `by_via`). Free includes 1,000 data rows and 10 active app users. A form request uses 2 rows and each change or note 1 more, so Free holds a few hundred leads. Tell the owner, and point them to "Delete lead" for spam.
- Free allows 25 subrequests per request, and each `ctx.data` call counts. Keep every route to a small, fixed number of calls: page through lists with `cursor` and a page link (like the board's "Older leads"), never by loading a whole collection.
- A custom slug or domain needs Starter. App Analytics (traffic, top pages, referrers, and errors for the app) needs Starter or above.
- Adding a third collection, a scheduled reminder job, or email notifications through a webhook pushes the plan up. Check the plan rules before adding them and tell the owner.

Safety:

- Never serve owner pages or lead data from a route that skips `requireOwner()` (outside demo mode).
- Keep both collections `server_only`. Public routes may create a lead but never read one back.
- Escape everything shown in HTML with `escapeHtml()`, and build `mailto:` links with `mailtoHref()`. Keep the length limits, the honeypot field, and `REQUEST_LIMITS` on public forms, and keep the owner's "Delete lead" so spam can be cleaned up.
- Keep the `isSameOrigin()` check on every form post. Other apps on `*.apps.userland.fun` are the same site for cookies, so without it they could post owner actions with the owner's session. Owner routes refuse posts with no `Origin`, `Sec-Fetch-Site`, or `Referer`.
- Catch `quota_exceeded` (the app is out of data rows) and show a page that tells visitors how else to reach the business, as `expectedErrorPage()` in `server/index.js` does.
- Don't log names, emails, phone numbers, or notes with `ctx.log`. Log ids and stages only.
- Keep any API keys (email or SMS providers) in Userland secrets and read them with `ctx.secrets` on the server.

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

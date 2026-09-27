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
4. Keep lead creation and stage changes in `ctx.data.transaction` so a lead and its history entry are saved together.
5. For a real business, remove demo mode (see below) before sharing the link with customers.
6. Validate the manifest with `npm run validate:manifests` and test with `npx vitest run examples/mini-crm`.
7. Publish with `userland apps publish <dir> --message "..."`. Then invite the owner as an app user with the `owner` role through `POST /v0/apps/:app_id/admin-invites` (see the Auth guide). The invite link lets them set a password and sign in at `/_userland/auth/login`. Before publishing, install the CLI with `npm install -g @userland.fun/cli` and sign in with `userland login` (it opens the browser to approve the CLI and never asks for a password). The invite call needs an API key in `USERLAND_API_KEY`, but `userland login` saves its key to `~/.userland/credentials.json`, not the environment: have the owner run `userland auth api-keys create --name "owner invite"` and export the printed key and the app id in their own terminal (README.md shows the commands), then unset and revoke that key once they have signed in.
8. Record the app ID and release ID in the project README so later publishes use `--app <app-id>`.

Demo mode:

- `server/demo.js` powers the public demo only. It lets visitors see the owner side without signing in and keeps each visitor's entries apart with a random key in the page address. Userland forwards only its own sign-in cookie to app code, so the key can't live in a cookie. Anyone with a visitor's link sees that visitor's entries, so the demo copy asks for made-up details; don't reword it into a privacy promise. `DEMO_LIMITS` caps each visitor and the demo as a whole.
- To remove it: delete `server/demo.js`, delete the `import { demo } from "./demo.js";` line in `server/index.js`, change the last line to `export default createApp();`, remove the `demo_visitor` fields and `by_demo_visitor` indexes from the manifest, and delete `tests/demo.test.ts`. The "turning demo mode off" test in `tests/mini-crm.test.ts` checks these steps. Do this before the first publish of a real app; removing fields later is a resource change.

Plan:

- The manifest fits the Free plan: server runtime, app-user auth with one role, two collections, and at most two indexes per collection. Free includes 1,000 data rows and 10 active app users.
- A custom slug or domain needs Starter. App Analytics (traffic, top pages, referrers, and errors for the app) needs Starter or above.
- Adding a third collection, a scheduled reminder job, or email notifications through a webhook pushes the plan up. Check the plan rules before adding them and tell the owner.

Safety:

- Never serve owner pages or lead data from a route that skips `requireOwner()` (outside demo mode).
- Keep both collections `server_only`. Public routes may create a lead but never read one back.
- Escape everything shown in HTML with `escapeHtml()`. Keep the length limits and the honeypot field on public forms.
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

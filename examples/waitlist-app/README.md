# Waitlist App

A pre-launch waitlist for a startup: a landing page that collects signups, a private page where each person sees their place in line, referral links that move people up, optional questions, and an owner view with filters, CSV export, top referrers, and recent activity.

The example is dressed as **Velto**, a made-up running app. Swap the name, copy, colors, and questions for your own launch.

Live demo: https://waitlist-demo.apps.userland.fun/ (example page: https://userland.fun/examples/waitlist-app/)

## What it does

Visitors:

- Read the landing page and join with an email and an optional first name.
- Land on a private page with their place in line and a personal invite link (`/r/CODE`).
- Move up 10 places for each friend who joins with their link.
- Optionally answer two questions and give their city.

The owner (signed in with the `owner` role):

- Sees everyone on the list with place in line, answers, referrals, and status.
- Searches, filters by status or answer, and sorts by place, newest, or referrals.
- Invites, archives, or restores people.
- Downloads the filtered list as CSV.
- Sees top referrers and recent activity.

## Userland capabilities

- Static files from `public/`: CSS, self-hosted fonts, icon, and a small optional copy-link script.
- Server routes in `server/index.js`, rendered as plain HTML (works without JavaScript).
- Managed data: the `signups` collection, with unique indexes on `email` and `referral_code`.
- App-user auth with one `owner` role. Owner pages call `ctx.auth.requireRole(request, "owner")`.
- Referral credit without a stored counter: each person's count is worked out from the friends whose `referred_by` names their code. A signup is one write, so friends joining at the same moment can't overwrite each other's credit, and archiving a fake signup takes its credit away.
- App events: every signup, answer update, status change, and export calls `ctx.log.info` (ids only, no emails), so it shows up in the Userland console and `userland apps events`.

## Plan

Publishes on the **Free** plan. The manifest uses server routes, app-user auth without public signup, one role, two data collections, and two indexes per collection, all within Free limits. Without the demo collection it uses one collection.

Usage limits still apply, and a busy launch can reach them:

- **Rows:** Free keeps up to 1,000 data rows per app, so a list that grows past about 1,000 signups needs Starter (25,000 rows).
- **Requests:** Free allows 10,000 requests a month across all your apps on the account. Every page, form post, and file counts, and a first visit to the landing page is about six (page, stylesheet, two fonts, script, icon). If your launch may get shared widely, plan on Starter (100,000 a month).
- **Compute per request:** the landing page reads only one page of signups (100 rows). The private place-in-line page and the owner view read the whole list, 100 rows per query, so they take longer as the list grows. Free gives each request 10 ms of compute and Starter 25 ms. Before launch day, test those two pages with a list the size you expect.

A slug (like `waitlist-demo`), a custom domain, and App Analytics are account features on paid plans; the app works without them.

## Spam and privacy

- The join form has a hidden honeypot field, length limits, and same-site checks, but no per-visitor rate limit. A script can still post many fake emails and push a Free list toward its 1,000-row limit. If that happens, sort the owner view by Newest first or search by email, and archive the junk (archived people also lose any referral credit they gave), and consider Starter for headroom.
- A repeat email gets the same neutral "Thanks, you're on the list" page as a bot, so the form can't be used to look up whether an address signed up. A brand-new email still goes straight to its private page. To close that last signal, email the private link instead of showing it (add an email provider key as a secret and send from the server).

## Files

```text
manifest.userland.json   app, runtime, auth role, data collections
public/                  app.css, fonts (OFL), favicon.svg, assets/share.js
server/index.js          routes, owner check, responses
server/waitlist.js       validation, referral codes, place in line, filters, CSV, storage
server/views.js          HTML for every page (all output escaped)
server/demo.js           demo mode only (see below)
tests/                   vitest tests with an in-memory ctx
```

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /` | Anyone | Landing page and join form (`?ref=CODE` credits a friend) |
| `POST /join` | Anyone | Validates and saves a signup, then redirects to the private page |
| `GET /r/:code` | Anyone | Short invite link, redirects to `/?ref=CODE` |
| `GET /thanks` | Anyone | Neutral confirmation for a repeat email (and for bots) |
| `GET /you/:id/:token` | The person who joined | Place in line, invite link, optional questions |
| `POST /you/:id/:token/answers` | The person who joined | Saves the optional answers |
| `GET /admin` | Owner | List, filters, stats, top referrers, recent activity |
| `GET /admin/export.csv` | Owner | CSV of the current filter |
| `POST /admin/signups/:id/status` | Owner | Invite, archive, or restore |

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/waitlist-app --message "Waitlist app"
```

The CLI prints `app_id`, `origin`, and `release_id`. Note them in your README so later updates use `--app <app_id>`.

## Make yourself the owner

Owner pages are closed until an app user with the `owner` role exists. The invite is an API request, so it needs an API key in `USERLAND_API_KEY`. `userland login` keeps its key in `~/.userland/credentials.json`, not in your shell, so create a key for the invite (the CLI shows it once, under `API key:`) and put it and the app id in your environment. Run this in your own terminal; the key never goes into the app.

```sh
userland auth api-keys create --name "waitlist-app owner invite"
export USERLAND_API_KEY="<the key printed under API key:>"
export APP_ID="<the app_id from the publish output>"

curl -fsS -X POST \
  -H "authorization: Bearer $USERLAND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"you@yourcompany.com","roles":["owner"]}' \
  "https://api.userland.fun/v0/apps/$APP_ID/admin-invites"
```

Open the `invite_url` from the response, choose a password, and you're signed in. Later, sign in at `<origin>/_userland/auth/login?return_to=/admin`. Once the owner has signed in, run `unset USERLAND_API_KEY` (CLI commands use that variable before your saved login), then revoke the invite key with `userland auth api-keys revoke <api-key-id>` (the id is printed as `Created API key ...`).

## Verify

```sh
ORIGIN=https://<app-id>.apps.userland.fun

# Join and follow the redirect to the private page
curl -si -X POST "$ORIGIN/join" --data 'email=ada@example.com&name=Ada' | grep -i location

# Owner pages redirect to sign-in when you're signed out
curl -si "$ORIGIN/admin" | grep -i location

# Recent app events
userland apps events "$APP_ID" --limit 10
```

Run the tests from the repo root:

```sh
npx vitest run examples/waitlist-app
```

## Demo mode

`server/demo.js` powers the public demo at `waitlist-demo.apps.userland.fun`. It only turns on for hostnames in `DEMO_HOSTS` (the demo's named address and the demo app's own address), so your copy runs as a normal waitlist anywhere else, including at your own `<app-id>.apps.userland.fun` address. In demo mode:

- The owner view opens without signing in.
- It shows made-up sample signups (all `@example.com`) plus only the signups that visitor added. A visitor's signups are tagged with a random key that travels in the link (`?demo=...`), because Userland passes only its own sign-in cookie to app code.
- Status changes to sample signups save a private copy for that visitor.
- The invite link on the private page only credits a friend inside the same demo, so the page links to a version with the visitor's demo key and says so.
- Signups go to the separate `demo-signups` collection, never to `signups`.
- The demo stays small on its own. Each visitor row carries `demo_expires_at`, a day after it was saved, and every demo write first deletes a batch of expired rows (listed oldest first by that indexed field). Each visitor can add up to 30 signups, and the whole demo holds at most 400 visitor rows; past that, visitors see a friendly "The demo is busy right now" page instead of an error. The cap has no rate limit behind it, so a script that posts a few hundred fake signups can keep the demo busy for everyone for up to a day. That is an accepted trade-off for a demo that holds no real data; a real waitlist never uses this cap.
- Every page gets `<meta name="robots" content="noindex,follow">` and a "Built with Userland" note.

To remove it:

1. Delete `server/demo.js`.
2. In `server/index.js`, delete the demo import and each `if (demo)` / `demoRequest` branch (the `openStore` and `siteFor` helpers show where).
3. Delete the `demo-signups` collection from `manifest.userland.json` (its `demo_key` and `demo_expires_at` fields and indexes go with it).
4. Delete the `public demo` tests.

## Customize

- Brand: color tokens and fonts are at the top of `public/assets/app.css`; the logo is `logoMark()` in `server/views.js`.
- Copy: `landingPage()` and `statusPage()` in `server/views.js`.
- Questions: `QUESTIONS` in `server/waitlist.js`. Keys are stored, labels are shown.
- Referral reward: `REFERRAL_BOOST` in `server/waitlist.js`.
- Invite emails: this example marks people as invited and exports CSV for your email tool. To send email from the app, add an email provider API key as a secret and call it from the server.

## Undo a release

```sh
userland apps releases "$APP_ID"
userland apps rollback "$APP_ID" "$RELEASE_ID"
```

Rollback moves the live version back. Signups and owner accounts are kept.

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
- App Analytics: https://docs.userland.fun/guides/app-analytics

Fonts: Unbounded and Inter, both under the SIL Open Font License (see `public/assets/fonts/`).

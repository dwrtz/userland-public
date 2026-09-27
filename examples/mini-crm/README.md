# Mini CRM

Lead inbox with a public request form and an owner-only board for stages, notes, follow-ups, and recent activity.

The example is dressed as Bevel & Brace, a fictional home-renovation contractor. Customers request a free estimate on the home page. The owner signs in to a lead board, filters by stage, opens a lead, moves it from new to won or lost, sets a follow-up date, adds notes, and deletes spam. Every change lands in a history that also feeds the board's recent activity.

Live demo: https://mini-crm-demo.apps.userland.fun/
Example page: https://userland.fun/examples/mini-crm/

## Capabilities

- Server runtime routes with server-rendered HTML and no client JavaScript.
- App-user auth with a single `owner` role and no public signup. Owner routes check `ctx.auth.currentUser(request)` for the role.
- Managed data: `leads` for the current state of each lead, `activity` for its history. The board queries leads by stage, newest first, and pages through them.
- A unique index (`by_request_key`) that limits how many requests one email address can send a day, even when they arrive at the same moment.
- `ctx.data.transaction` to group a lead with its first history entry. It doesn't undo the first write if the second fails, so a lead can exist without its history entry; the pages handle that.
- App events from `ctx.log` for received leads, stage changes, and notes (ids only, no contact details).
- Rollback to an earlier release without losing leads.

## Plan

Free. The manifest uses the server runtime, app-user auth with one role, two collections, and at most two indexes per collection. Free includes 1,000 data rows and 10 active app users. A custom slug or domain, and App Analytics, need Starter.

Each request from the form uses 2 data rows (the lead and its history entry), and each stage change, follow-up date, or note uses 1 more, so Free holds a few hundred leads. See [Spam and limits](#spam-and-limits) for how the app keeps a script from using them up, and what happens when they run out.

## Files

| Path | What it does |
| --- | --- |
| `manifest.userland.json` | App metadata, runtime, the `owner` role, and the `leads` and `activity` collections |
| `server/index.js` | Routes and the owner gate |
| `server/leads.js` | Option lists, validation, and the `ctx.data` store |
| `server/views.js` | HTML for every page |
| `server/demo.js` | Demo mode for the public demo only (see below) |
| `public/assets/crm.css` | Brand and layout |
| `public/fonts/` | Barlow Condensed and IBM Plex Sans Condensed, self-hosted (SIL Open Font License) |
| `tests/mini-crm.test.ts` | Form validation, limits on the form, the owner gate and origin checks, deleting leads, board pages, demo mode staying off outside the demo's addresses, and removing the demo code |
| `tests/demo.test.ts` | Demo mode only: demo privacy, limits, and clean-up |
| `tests/helpers.ts` | Test `ctx` built from the manifest by `scripts/runtime-harness.ts` |

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /` | Anyone | Estimate request form |
| `POST /estimate` | Anyone | Save a request as a new lead |
| `GET /thanks` | Anyone | Confirmation |
| `GET /admin` | Owner | Lead board with stage filter (`?stage=quoted`), stats, recent activity, and 50 leads per page (`?after=` from the "Older leads" link) |
| `GET /admin/leads/new` | Owner | Add a lead by hand |
| `POST /admin/leads` | Owner | Save it |
| `GET /admin/leads/:id` | Owner | Lead detail and history |
| `POST /admin/leads/:id/stage` | Owner | Change stage and follow-up date |
| `POST /admin/leads/:id/notes` | Owner | Add a note |
| `POST /admin/leads/:id/delete` | Owner | Delete the lead and its history (needs `confirm=yes`) |

Sign-in, sign-out, and invite acceptance are Userland's reserved routes under `/_userland/auth/*`.

Every form post must come from the app's own pages. Other apps on `*.apps.userland.fun` count as the same site for cookies, so the owner's sign-in cookie would ride along on their form posts; `isSameOrigin()` in `server/index.js` refuses a post whose `Origin` (or, without it, `Sec-Fetch-Site` or `Referer`) isn't this app. Owner routes also refuse a post that has none of the three. Form bodies over 16 KiB are refused while they're being read, with or without a `Content-Length` header.

## Data model

- `leads`: `name`, `email`, `phone`, `project`, `budget`, `timeline`, `details`, `stage`, `source`, `follow_up_on`, `received_at`, `request_key`, plus `id`, `created_at`, `updated_at`. Indexes: `by_stage` (`stage`, `received_at`) for the board, and `by_request_key` (unique) for the per-email limit. `request_key` is the UTC day, a hash of the email address, and a slot number; leads the owner adds have none.
- `activity`: `lead_id`, `lead_name`, `kind` (`received`, `added`, `stage`, `follow_up`, `note`), `stage`, `body`, plus `id` and `created_at`. Index: `by_lead`. The demo adds `demo_visitor` and `demo_saved_at` and the `by_demo_visitor` index (see [Demo mode](#demo-mode)).

Both collections are `server_only`. Public routes can create a lead but never read one back.

The board loads one page of 50 leads and counts up to 100 leads per stage; a stage with more shows "100+". Every request makes a small, fixed number of data calls, since each one counts toward the plan's subrequests per request (25 on Free).

## Spam and limits

The form has a hidden honeypot field that drops simple bots. On top of that, `REQUEST_LIMITS` in `server/leads.js` sets:

- `perEmailPerDay` (3): requests one email address can send in a UTC day. Each address gets that many slots in the unique `by_request_key` index, so simultaneous requests can't get past it.
- `perHour` (20) and `perDay` (60): requests the form takes across everyone. One query checks them before saving, so a burst of simultaneous requests can pass them by a few. Leads the owner adds count toward them but are never refused.

A refused visitor sees a page with the business phone number. When the app runs out of data rows, the form shows "We can't take requests online right now" with the phone number, the owner board says how to make room, and the app logs a `data row limit reached` event. The owner deletes spam from each lead's page ("Delete lead"); a lead with a long history may take a second press, since each request removes at most 15 history entries.

These limits count requests, not senders: Userland doesn't document a visitor IP header for app code, so a script that changes its email address still gets `perHour` requests through. Lower the numbers if that's too many for the plan's rows.

## Publish

Demo mode only turns on at the public demo's addresses, so a copy you publish anywhere else runs the signed-in owner board. For a real business, still remove the demo code before the first publish (see [Demo mode](#demo-mode)); removing its fields later is a resource change.

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/mini-crm --message "Mini CRM"
```

Then invite the owner as an app user with the `owner` role. The invite is an API request, so it needs an API key in `USERLAND_API_KEY`. `userland login` keeps its key in `~/.userland/credentials.json`, not in your shell, so create a key for the invite (the CLI shows it once, under `API key:`) and put it and the app id in your environment. Run this in your own terminal; the key never goes into the app.

```sh
userland auth api-keys create --name "mini-crm owner invite"
export USERLAND_API_KEY="<the key printed under API key:>"
export APP_ID="<the app_id from the publish output>"

curl -fsS -X POST \
  -H "authorization: Bearer $USERLAND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"owner@yourbusiness.com","roles":["owner"]}' \
  "https://api.userland.fun/v0/apps/$APP_ID/admin-invites"
```

The owner opens the invite link, sets a password, and signs in at `/_userland/auth/login?return_to=/admin`. Once the owner has signed in, run `unset USERLAND_API_KEY` (CLI commands use that variable before your saved login), then revoke the invite key with `userland auth api-keys revoke <api-key-id>` (the id is printed as `Created API key ...`).

## Demo mode

`server/demo.js` exists for the public demo. It only turns on for requests to the hostnames in `DEMO_HOSTS` (`mini-crm-demo.apps.userland.fun` and the demo app's own address). Anywhere else the owner routes require a signed-in owner and leads are saved normally, even with `demo.js` still in place. On the demo addresses it lets visitors see the owner side without signing in and keeps visitors' entries apart: each visitor gets a random key in the page address, and the owner view shows the sample leads plus only rows saved with that key. Changes to a sample lead are saved as history for that visitor only.

The demo saves only `activity` rows, tagged with the visitor's key and the time (`demo_visitor`, `demo_saved_at`); a lead a visitor adds is its first row. The key is the only thing tying entries to a visitor, so anyone who has a visitor's link sees that visitor's entries. The demo pages say this plainly and ask visitors to use made-up details. Visitors who only look around save nothing.

Limits (`DEMO_LIMITS` and `DEMO_KEEP_HOURS` in `server/demo.js`): each visitor can save up to 10 leads and 40 entries, and the whole demo takes at most 60 entries in any hour. A visitor without a key gets a new one on their first save, so the hourly limit is the one that holds against scripts. Entries are removed 12 hours after they're saved: each save first deletes up to 4 expired rows. The demo therefore holds at most about 720 rows, inside Free's 1,000.

To remove the demo code for a real business, before the first publish:

1. Delete `server/demo.js`.
2. In `server/index.js`, delete the `import { demo } from "./demo.js";` line and change the last line to `export default createApp();`.
3. In `manifest.userland.json`, in the `activity` collection, remove the `demo_visitor` and `demo_saved_at` fields and the `by_demo_visitor` index. Keep `by_lead`.
4. Delete `tests/demo.test.ts` (the demo-mode tests).

The owner routes require a signed-in app user with the `owner` role. The "the published app outside the demo's addresses" test in `tests/mini-crm.test.ts` checks that a copy published elsewhere keeps the owner board behind sign-in. The "turning demo mode off" tests run steps 1 to 4 on a copy of the example and then run the copy's remaining tests, so `npx vitest run examples/mini-crm` still passes after you follow the steps.

## Verify

```sh
npx vitest run examples/mini-crm
```

After publishing:

```sh
curl -s -o /dev/null -w '%{http_code}\n' <origin>/                 # 200
curl -s -o /dev/null -w '%{http_code}\n' <origin>/admin            # 303 to sign-in
curl -s -X POST <origin>/estimate \
  --data-urlencode name='Test Lead' --data-urlencode email=test@example.com \
  --data-urlencode project=kitchen --data-urlencode budget=not_sure \
  --data-urlencode timeline=planning --data-urlencode details='Testing the request form.' \
  -o /dev/null -w '%{http_code} %{redirect_url}\n'                  # 303 to /thanks
userland apps events <app-id> --severity error --limit 25
```

## Roll back

```sh
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
```

Rollback moves the live version back. Leads, history, and app users stay as they are.

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

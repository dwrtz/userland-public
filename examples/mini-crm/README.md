# Mini CRM

Lead inbox with a public request form and an owner-only board for stages, notes, follow-ups, and recent activity.

The example is dressed as Bevel & Brace, a fictional home-renovation contractor. Customers request a free estimate on the home page. The owner signs in to a lead board, filters by stage, opens a lead, moves it from new to won or lost, sets a follow-up date, adds notes, and deletes spam. Every change lands in a history that also feeds the board's recent activity.

Live demo: https://mini-crm-demo.apps.userland.fun/
Example page: https://userland.fun/examples/mini-crm/

## Capabilities

- Server runtime routes with server-rendered HTML and no client JavaScript.
- App-user auth with a single `owner` role and no public signup. Owner routes check `ctx.auth.currentUser(request)` for the role.
- Managed data: `leads` for the current state of each lead, `activity` for its history. The board queries leads by stage, newest first, and pages through them.
- Limits on the public form that hold even when requests arrive at the same moment: a request counts recent requests, saves its lead, counts again, and takes the lead back if it went over (see [Spam and limits](#spam-and-limits)).
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

- `leads`: `name`, `email`, `phone`, `project`, `budget`, `timeline`, `details`, `stage`, `source`, `follow_up_on`, `received_at`, `via`, plus `id`, `created_at`, `updated_at`. `via` is `form` for requests from the public form and `owner` for leads the owner adds. Indexes: `by_stage` (`stage`, `received_at`) for the board, and `by_via` (`via`, `received_at`) for the form's limits. `demo_visitor` is unused: earlier versions of the demo saved leads with it, and Userland won't make a release live if it removes a field the published app already has.
- `activity`: `lead_id`, `lead_name`, `kind` (`received`, `added`, `stage`, `follow_up`, `note`), `stage`, `body`, plus `id` and `created_at`. Index: `by_lead`. The demo adds `demo_visitor` and `demo_saved_at` and the `by_demo_visitor` index (see [Demo mode](#demo-mode)).

Leads saved by an earlier version of this example have no `received_at` and would sort ahead of every new lead. Each visit to the board fills it in from `created_at` for up to 12 of them (`REPAIR_BATCH` in `server/leads.js`), so after a few visits they sort by age with the rest.

Both collections are `server_only`. Public routes can create a lead but never read one back.

The board loads one page of 50 leads and counts up to 100 leads per stage; a stage with more shows "100+". Every request makes a small, fixed number of data calls, since each one counts toward the plan's subrequests per request (25 on Free).

## Spam and limits

The form has a hidden honeypot field that drops simple bots. On top of that, `REQUEST_LIMITS` in `server/leads.js` sets:

- `perEmailPerDay` (3): requests one email address can send in 24 hours.
- `perHour` (20) and `perDay` (60): requests the form takes from everyone in the last hour and the last 24 hours.

Only requests from the form count. Leads the owner adds never count toward these limits and are never refused, so a busy day of phone leads doesn't close the form.

Each request counts the recent form leads (one query on `by_via`), saves its lead, then counts again with its own lead included and takes the lead back if that count is over a limit. Whatever order simultaneous requests run in, the last one to count sees every lead that stays, so the leads that stay never pass a limit, even in a burst. The cost: a few requests arriving together right at a limit can all be turned away, and while a burst is being counted its leads briefly use data rows before they're taken back. Keep `perDay` under 100, the most leads one count can see.

A refused visitor sees a page with the business phone number. When the app runs out of data rows, the form shows "We can't take requests online right now" with the phone number, the owner board says how to make room, and the app logs a `data row limit reached` event. The owner deletes spam from each lead's page ("Delete lead"); a lead with a long history may take a second press, since each request removes at most 15 history entries.

These limits count requests, not senders: Userland doesn't document a visitor IP header for app code, so a script that changes its email address still gets `perHour` requests through each hour and `perDay` each day. At 2 rows a request, a script running every day adds 120 rows a day until the owner deletes them. Lower the numbers if that's too many for the plan's rows.

## Publish

Demo mode only turns on at the public demo's addresses, so a copy you publish anywhere else runs the signed-in owner board. For a real business, still remove the demo code before the first publish (see [Demo mode](#demo-mode)). Once a copy is published, keep its fields: Userland won't make a release live if it removes a field the app already has, so a copy published with the demo fields keeps them (unused) even after you delete `server/demo.js`.

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/mini-crm --message "Mini CRM"
```

Then invite the owner as an app user with the `owner` role:

```sh
export APP_ID="<the app_id from the publish output>"
userland apps invites create "$APP_ID" --email owner@yourbusiness.com --role owner
```

`apps invites create` needs CLI 0.9.0 or later (`npm install -g @userland.fun/cli@latest` updates it). It uses the key saved by `userland login`, so there is no API key to make or revoke. It prints only the invite link, which works for 7 days (add `--expires-in-days 30` for longer). Give the link only to the owner: whoever has it can set the password once.

The owner opens the invite link, sets a password, and signs in at `/_userland/auth/login?return_to=/admin`.

## Demo mode

`server/demo.js` exists for the public demo. It only turns on for requests to the hostnames in `DEMO_HOSTS` (`mini-crm-demo.apps.userland.fun` and the demo app's own address). Anywhere else the owner routes require a signed-in owner and leads are saved normally, even with `demo.js` still in place. On the demo addresses it lets visitors see the owner side without signing in and keeps visitors' entries apart: each visitor gets a random key in the page address, and the owner view shows the sample leads plus only rows saved with that key. Changes to a sample lead are saved as history for that visitor only.

The demo saves only `activity` rows, tagged with the visitor's key and the time (`demo_visitor`, `demo_saved_at`); a lead a visitor adds is its first row. The key is the only thing tying entries to a visitor, so anyone who has a visitor's link sees that visitor's entries. The demo pages say this plainly and ask visitors to use made-up details. Visitors who only look around save nothing.

Limits (`DEMO_LIMITS` and `DEMO_KEEP_HOURS` in `server/demo.js`): each visitor can save up to 10 leads and 40 entries, and the whole demo takes at most 60 entries in any hour. A visitor without a key gets a new one on their first save, so the hourly limit is the one that holds against scripts. Like the public form's limits, it counts again after saving and takes the entries back if the hour is over, so it holds even when saves arrive at the same moment. Entries are removed 12 hours after they're saved: each save first deletes up to 4 expired rows. The demo therefore holds at most 720 rows, inside Free's 1,000.

To remove the demo code for a real business, before the first publish:

1. Delete `server/demo.js`.
2. In `server/index.js`, delete the `import { demo } from "./demo.js";` line and change the last line to `export default createApp();`.
3. In `manifest.userland.json`, remove the `demo_visitor` field from the `leads` collection, and in the `activity` collection remove the `demo_visitor` and `demo_saved_at` fields and the `by_demo_visitor` index. Keep `by_lead`. Only do this step before the first publish (see [Publish](#publish)).
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

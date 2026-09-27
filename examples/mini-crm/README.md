# Mini CRM

Lead inbox with a public request form and an owner-only board for stages, notes, follow-ups, and recent activity.

The example is dressed as Bevel & Brace, a fictional home-renovation contractor. Customers request a free estimate on the home page. The owner signs in to a lead board, filters by stage, opens a lead, moves it from new to won or lost, sets a follow-up date, and adds notes. Every change lands in a history that also feeds the board's recent activity.

Live demo: https://mini-crm-demo.apps.userland.fun/
Example page: https://userland.fun/examples/mini-crm/

## Capabilities

- Server runtime routes with server-rendered HTML and no client JavaScript.
- App-user auth with a single `owner` role and no public signup. Owner routes check `ctx.auth.currentUser(request)` for the role.
- Managed data: `leads` for the current state of each lead, `activity` for its history.
- `ctx.data.transaction` so a lead and its first history entry are saved together.
- App events from `ctx.log` for received leads, stage changes, and notes (ids only, no contact details).
- Rollback to an earlier release without losing leads.

## Plan

Free. The manifest uses the server runtime, app-user auth with one role, two collections, and at most two indexes per collection. Free includes 1,000 data rows and 10 active app users. A custom slug or domain, and App Analytics, need Starter.

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
| `tests/mini-crm.test.ts` | Form validation, the owner gate, and demo privacy |

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /` | Anyone | Estimate request form |
| `POST /estimate` | Anyone | Save a request as a new lead |
| `GET /thanks` | Anyone | Confirmation |
| `GET /admin` | Owner | Lead board with stage filter (`?stage=quoted`), stats, and recent activity |
| `GET /admin/leads/new` | Owner | Add a lead by hand |
| `POST /admin/leads` | Owner | Save it |
| `GET /admin/leads/:id` | Owner | Lead detail and history |
| `POST /admin/leads/:id/stage` | Owner | Change stage and follow-up date |
| `POST /admin/leads/:id/notes` | Owner | Add a note |

Sign-in, sign-out, and invite acceptance are Userland's reserved routes under `/_userland/auth/*`.

## Data model

- `leads`: `name`, `email`, `phone`, `project`, `budget`, `timeline`, `details`, `stage`, `source`, `follow_up_on`, plus `id`, `created_at`, `updated_at`.
- `activity`: `lead_id`, `lead_name`, `kind` (`received`, `added`, `stage`, `follow_up`, `note`), `stage`, `body`, plus `id` and `created_at`.

Both collections are `server_only`. Public routes can create a lead but never read one back.

## Publish

```sh
userland apps publish examples/mini-crm --message "Mini CRM"
```

Then invite the owner as an app user with the `owner` role:

```sh
curl -fsS -X POST \
  -H "authorization: Bearer $USERLAND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"owner@yourbusiness.com","roles":["owner"]}' \
  "https://api.userland.fun/v0/apps/$APP_ID/admin-invites"
```

The owner opens the invite link, sets a password, and signs in at `/_userland/auth/login?return_to=/admin`.

## Demo mode

`server/demo.js` exists for the public demo. It lets visitors see the owner side without signing in and keeps visitors' entries apart: each visitor gets a random key in the page address, and the owner view shows the sample leads plus only rows saved with that key. Changes to a sample lead are saved as history for that visitor only.

The key is the only thing tying entries to a visitor, so anyone who has a visitor's link sees that visitor's entries. The demo pages say this plainly and ask visitors to use made-up details. Each visitor can save up to 25 leads and 90 history entries, and the whole demo stops taking new entries at 1,500 history rows (`DEMO_LIMITS` in `server/demo.js`). Visitors who only look around save nothing.

To turn it off for a real business, before the first publish:

1. Delete `server/demo.js`.
2. In `server/index.js`, delete the `import { demo } from "./demo.js";` line and change the last line to `export default createApp();`.
3. In `manifest.userland.json`, remove the `demo_visitor` fields and the `by_demo_visitor` indexes.

The owner routes then require a signed-in app user with the `owner` role.

## Verify

```sh
npx vitest run examples/mini-crm
```

After publishing:

```sh
curl -s -o /dev/null -w '%{http_code}\n' <origin>/                 # 200
curl -s -o /dev/null -w '%{http_code}\n' <origin>/admin            # 303 to sign-in when demo mode is off
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

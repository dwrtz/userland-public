# Booking App

Lesson booking for **Wrenhouse Music Studio**, a made-up piano and voice teacher. Visitors pick a lesson, request a time, and get a confirmation. The owner signs in to a private studio desk to confirm or decline requests, edit lessons and prices, and review recent activity.

- Live demo: https://booking-demo.apps.userland.fun/
- Example page: https://userland.fun/examples/booking-app/
- Plan: works on the **Free** plan (see [Plans](#plans)).

## What it shows

- Server-rendered pages from `server/index.js`, with no client-side JavaScript.
- Managed data: `services` (lessons) and `bookings` (requests), declared in `manifest.userland.json`.
- Form handling with validation, length limits, a honeypot field, and escaped output.
- Double-booking protection: the requested time is checked again inside `ctx.data.transaction` right before the booking is saved.
- App-user auth: `/studio` pages require a signed-in app user with the `owner` role.
- App events: every request, status change, and lesson edit is logged with `ctx.log` (ids only, no contact details).
- Release history and rollback with the Userland CLI.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /` | Public | Studio home and lesson list |
| `GET /book` | Public | Booking form (`?service=` and `?date=` pick the lesson and day) |
| `POST /book` | Public | Validate and save a request, then redirect to the confirmation |
| `GET /booked?ref=` | Public | Confirmation for one request |
| `GET /studio` | Owner | Booking inbox with New, Confirmed, Declined & cancelled, and All tabs |
| `POST /studio/bookings/:id/status` | Owner | Confirm, decline, cancel, or reopen a request |
| `GET /studio/lessons` | Owner | Edit lessons, lengths, prices, and visibility |
| `POST /studio/lessons` | Owner | Add a lesson |
| `POST /studio/lessons/:id` | Owner | Save a lesson |
| `POST /studio/lessons/starter` | Owner | Add four starter lessons to an empty studio |
| `GET /studio/activity` | Owner | Recent requests and status changes |

Sign-in, sign-out, and invite acceptance use Userland's built-in `/_userland/auth/*` pages.

## Files

- `manifest.userland.json`: app metadata, runtime, `owner` role, and the two data collections.
- `server/index.js`: routes, validation, data access, and the owner gate.
- `server/views.js`: HTML for every page, the studio name, and the logo.
- `server/schedule.js`: opening hours, time zone, notice period, and time slots.
- `server/demo.js`: demo-only behavior (see [Demo mode](#demo-mode)).
- `public/assets/`: stylesheet and self-hosted fonts (Newsreader and Instrument Sans, SIL Open Font License).
- `tests/booking-app.test.ts`: the booking flow, validation, privacy between demo visitors, and the owner gate.

## Make it yours

1. Studio name, teacher, address, and email: `STUDIO` in `server/views.js`.
2. Opening hours, time zone, notice period, and booking window: `STUDIO_HOURS` in `server/schedule.js`.
3. Starter lessons: `STARTER_SERVICES` in `server/index.js`. After launch, edit lessons from `/studio/lessons`.
4. Colors and fonts: the tokens at the top of `public/assets/styles.css`.

## Demo mode

The public demo at https://booking-demo.apps.userland.fun/ lets anyone open the owner pages without signing in. That behavior lives in `server/demo.js`:

- Each visitor gets a random key the first time they submit a form. Their bookings and edits are stored with that key and shown only to them. Everyone else sees made-up sample data.
- The first owner-side change copies the samples into the visitor's own set (`demo_copy_of` records which sample each copy came from), so their changes never reach anyone else. If a double-click copies a sample twice, the oldest copy is the one shown and changed.
- Every visitor row gets a `demo_expires_at` time a day ahead. Each demo write deletes a batch of expired rows, reading them oldest-expiry first so none are missed however busy the demo gets.
- Every page is marked `noindex` with a "Built with Userland" note.

**Demo mode only turns on at the addresses in `DEMO_HOSTS`** (the Userland demo deployment). On any other address, including your app's own `*.apps.userland.fun` origin and your custom domain, the owner pages require sign-in, public pages are indexable, and the demo notes disappear. A copy of this example is never published with an open owner desk.

To remove demo mode completely:

1. Delete `server/demo.js`, its import, and every `rc.demoMode` branch in `server/index.js` (including `scopeFields`).
2. In `manifest.userland.json`, drop the `demo_key`, `demo_expires_at`, and `demo_copy_of` fields and rebuild both indexes without them, for example services `by_order` on `["sort_order"]` and bookings `by_status` on `["status", "starts_at"]`. Keep `by_ref`.
3. Remove `where: { demo_key: ... }` from the queries in `server/index.js`.

## Publish

```sh
userland apps publish examples/booking-app --message "First release"
```

The output includes the `app_id`, origin, and `release_id`. Record them in your project notes. Later releases:

```sh
userland apps publish examples/booking-app --app "$APP_ID" --message "Update lesson prices"
```

## Invite the owner

Create an owner invite through the Userland API. The response includes an `invite_url`; the owner opens it and sets a password.

```sh
curl -fsS -X POST \
  -H "authorization: Bearer $USERLAND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","roles":["owner"]}' \
  "https://api.userland.fun/v0/apps/$APP_ID/admin-invites"
```

After that, the owner signs in at `<origin>/studio`. The app does not allow public sign-up (`public_signup: false`).

## Verify

```sh
npx vitest run examples/booking-app
curl -s <origin>/ | grep -o '<title>[^<]*'
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' <origin>/studio   # 303 to the sign-in page
userland apps events "$APP_ID" --limit 25
userland apps events "$APP_ID" --severity error --limit 25
```

## Undo a release

Every publish is a release you can go back to (Free keeps the last 2 releases, Starter keeps 10). Rollback moves the live pointer only; bookings, lessons, and app users are kept.

```sh
userland apps releases "$APP_ID"
userland apps rollback "$APP_ID" "$RELEASE_ID"
```

## Plans

The manifest publishes on the **Free** plan: server routes, app-user auth with one role and no public sign-up, and two data collections with two indexes each. Free includes up to 1,000 saved rows and 10,000 requests a month.

Paid plans add things around the app, not in the manifest: a named address such as `your-studio.apps.userland.fun` or your own domain (Starter and up), and traffic analytics for visits, popular pages, and referrers (Starter and up). Adding email reminders with a scheduled job would also need Starter.

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

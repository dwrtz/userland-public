# Booking App

Lesson booking for **Wrenhouse Music Studio**, a made-up piano and voice teacher. Visitors pick a lesson, request a time, and get a confirmation. The owner signs in to a private studio desk to confirm or decline requests, edit lessons and prices, and review recent activity.

- Live demo: https://booking-demo.userland.link/
- Example page: https://userland.fun/examples/booking-app/
- Plan: works on the **Free** plan (see [Plans](#plans)).

## What it shows

- Server-rendered pages from `server/index.js`, with no client-side JavaScript.
- Managed data: `services` (lessons) and `bookings` (requests), declared in `manifest.userland.json`.
- Form handling with validation, length limits, a honeypot field, and escaped output.
- Double-booking protection with a unique index: each request holds its half-hour blocks of the calendar, and Userland allows only one hold per block, even when two people ask at the same moment (see [Double-booking protection](#double-booking-protection)).
- Limits on unanswered requests, so a script can't hold every open time or fill the plan's storage (see [Spam and storage](#spam-and-storage)).
- Owner lists that read one status at a time with indexed queries and page through everything, however long the studio's history gets.
- App-user auth: `/studio` pages require a signed-in app user with the `owner` role, and owner forms must come from the app's own pages (checked with the `Origin` header).
- App events: every request, status change, and lesson edit is logged with `ctx.log` (ids only, no contact details).
- Release history and rollback with the Userland CLI.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /` | Public | Studio home and lesson list |
| `GET /book` | Public | Booking form (`?service=` and `?date=` pick the lesson and day) |
| `POST /book` | Public | Validate and save a request, then redirect to the confirmation |
| `GET /booked?ref=` | Public | Confirmation for one request (not indexed by search engines) |
| `GET /studio` | Owner | Booking inbox with New, Upcoming, Past lessons, Declined, and Cancelled tabs (`?show=`), 25 per page with **Show more** (`?after=`) |
| `POST /studio/bookings/:id/status` | Owner | Confirm, decline, cancel, or reopen a request |
| `POST /studio/bookings/:id/delete` | Owner | Delete a request (not a confirmed lesson that is still to come) |
| `POST /studio/bookings/clear-out` | Owner | Delete past lessons, declined, or cancelled requests from more than 30 days ago, 12 per click |
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
- `tests/booking-app.test.ts`: the booking flow, validation, the owner gate, the owner's changes, double booking under concurrent requests, long histories and paging, request limits, and removing demo mode.
- `tests/demo.test.ts`: demo mode only, including privacy between demo visitors, the per-visitor cap, and clean-up.

## Make it yours

1. Studio name, teacher, address, and email: `STUDIO` in `server/views.js`.
2. Opening hours, time zone, notice period, and booking window: `STUDIO_HOURS` in `server/schedule.js`.
3. Starter lessons: `STARTER_SERVICES` in `server/index.js`. After launch, edit lessons from `/studio/lessons`.
4. Limits on unanswered requests: `REQUEST_LIMITS` in `server/index.js`. What "Clear out" deletes: `CLEAR_OUT`.
5. Colors and fonts: the tokens at the top of `public/assets/styles.css`.

## Double-booking protection

Every request that holds a time (`new` or `confirmed`) owns one hold row per half-hour block its lesson touches. Hold rows live in the `bookings` collection with `status: "hold"`, a `hold` key such as `|2026-10-01T22:00:00.000Z` (scope and block start), and `hold_for` (the request's reference). The `by_hold` index makes `hold` unique, and Userland enforces unique values atomically, so when two people ask for overlapping times at the same moment only one can create the holds. The other gets `unique_conflict` and sees "Sorry, that time was just taken."

`ctx.data.transaction` groups the writes, but it does not stop two requests from running at once, so it can't prevent double booking by itself. The list check before saving is only there for a friendly message in the usual case.

Holds are given back when a request is declined, cancelled, or deleted, and taken again when the owner confirms a request or moves it back to new. If someone else has the time by then, the owner sees "Someone else has that time now" and nothing changes. Holds for lessons that are over are deleted a few at a time on each new request.

Every query for requests filters on `status`, so hold rows never show up as requests. Keep it that way if you add pages.

## Spam and storage

The public form has a hidden honeypot field, and `REQUEST_LIMITS` in `server/index.js` caps unanswered requests: 3 from one email address, 15 that arrived in the last 24 hours, and 30 in total. Requests that arrive at the same moment are checked again once saved, and any that went over are taken back, so a burst of requests can't get past the caps. When a cap is reached, the booking page asks people to email the studio, and the owner's inbox says booking is paused until some requests are confirmed, declined, or deleted. Userland doesn't pass visitors' IP addresses to app code, so there is no per-visitor limit beyond the email address.

The Free plan saves up to 1,000 rows across both collections. Each request is one row, plus one to three holds while its lesson is still to come. From the owner's side, delete spam from the New tab, and every few months select **Clear out** on the Past lessons, Declined, and Cancelled tabs. If the plan is full anyway, visitors see "Online booking is paused" with the studio's email address instead of an error.

## Demo mode

The public demo at https://booking-demo.userland.link/ lets anyone open the owner pages without signing in. That behavior lives in `server/demo.js`:

- Each visitor gets a random key the first time they submit a form. Their bookings and edits are stored with that key and shown only to them. Everyone else sees made-up sample data.
- The first owner-side change copies the samples into the visitor's own set (`demo_copy_of` records which sample each copy came from), so their changes never reach anyone else. If a double-click copies a sample twice, the oldest copy is the one shown and changed.
- Every visitor row gets a `demo_expires_at` time a day ahead. Each demo write deletes a batch of expired rows, reading them oldest-expiry first so none are missed however busy the demo gets.
- One visitor can have at most `MAX_VISITOR_ROWS` rows at a time, so a single visit can't fill the demo's storage. Sample bookings can't be deleted.
- The ribbon asks visitors to use made-up details, since anyone with a page's link (which carries the key) can see them.
- Every page is marked `noindex` with a "Built with Userland" note.

**Demo mode only turns on at the addresses in `DEMO_HOSTS`** (the Userland demo deployment). On any other address, including your app's own `*.userland.link` origin and your custom domain, the owner pages require sign-in, public pages are indexable, and the demo notes disappear. A copy of this example is never published with an open owner desk.

To remove demo mode completely:

1. Delete `server/demo.js` and `tests/demo.test.ts`.
2. In `server/index.js`, delete every line that ends with `// demo`.

That's all. The `demo_key`, `demo_expires_at`, and `demo_copy_of` fields in `manifest.userland.json` can stay: every row a real studio saves has an empty `demo_key`, and the queries and ownership checks in `server/index.js` rely on that. The "removing demo mode" test in `tests/booking-app.test.ts` runs exactly these steps on a copy of `server/` and checks that booking, confirmation, status changes, and lesson edits still work, so mark any line you add for the demo the same way.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/booking-app --message "First release"
```

The output includes the `app_id`, origin, and `release_id`. Record them in your project notes. Later releases:

```sh
userland apps publish examples/booking-app --app "$APP_ID" --message "Update lesson prices"
```

## Invite the owner

Create an owner invite with the CLI. The owner opens the link it prints and sets a password.

```sh
export APP_ID="<the app_id from the publish output>"
userland apps invites create "$APP_ID" --email owner@example.com --role owner
```

`apps invites create` needs CLI 0.9.0 or later (`npm install -g @userland.fun/cli@latest` updates it). It uses the key saved by `userland login`, so there is no API key to make or revoke. It prints only the invite link, which works for 7 days (add `--expires-in-days 30` for longer). Give the link only to the owner: whoever has it can set the password once.

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

The manifest publishes on the **Free** plan: server routes, app-user auth with one role and no public sign-up, and two data collections (`services` with one index, `bookings` with two, one of them unique). Free includes up to 1,000 saved rows and 10,000 requests a month; see [Spam and storage](#spam-and-storage) for keeping bookings under the row limit.

Paid plans add things around the app, not in the manifest: a short address such as `your-studio.userland.link` or your own domain (Starter and up), and traffic analytics for visits, popular pages, and referrers (Starter and up). Adding email reminders with a scheduled job would also need Starter.

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

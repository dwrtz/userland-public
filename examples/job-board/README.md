# Job Board

A niche job board with public listings, search and category filters, an employer "Post a job" form, and an owner review queue. The example is dressed as **Loamwork**, a made-up board for farm and food jobs in the Pacific Northwest. Rename it, recolor it, and swap the categories to fit your community.

- Live demo: https://job-board-demo.userland.link/
- Walkthrough and copyable prompt: https://userland.fun/examples/job-board/
- Plan: runs on the **Free** plan. See [Plan notes](#plan-notes).

## What it does

Visitors can:

- browse open jobs, newest and featured first, 100 to a page with an "Older jobs" link;
- filter by kind of work and schedule, and search by job, farm, or town;
- open a job page with pay, location, the full description, and how to apply;
- post a job through a form that goes to the owner for review.

The owner can:

- sign in and see every listing, grouped by status (to review, live, declined, closed), 100 to a page with a "Show more" link;
- approve or decline new listings, and mark live ones as filled;
- delete a listing, or clear out declined listings (spam) in batches of 15;
- edit any listing, feature it at the top of the board, and keep a private note;
- see recent activity on the listings in view, and the activity log and errors in the Userland console (visits, top pages, and referrers need Starter).

## Capabilities

- Server routes that render every page as plain HTML (no client-side JavaScript).
- Managed data: a `listings` collection with two indexes, `by_status` (`status`, `category`, `job_type`, `published_at`) for the public board and its filters, and `by_submitted` (`status`, `submitted_at`) for the owner's lists. Lists are read one page at a time, so nothing drops off after the first 100 rows, and each page view makes at most two list calls (see [Data](#data)).
- App-user auth with a single `owner` role and public signup turned off.
- App events: each submission, review decision, and edit is written with `ctx.log`.
- A JobPosting structured-data block on each job page.

## Files

```text
manifest.userland.json   App, runtime, auth, and data declarations
server/index.js          Routes, the owner gate, and form handling
server/listings.js       Categories, validation rules, and the listings store
server/views.js          Page templates and the escaping helper
server/demo.js           Demo mode for the public demo (delete it for your own board)
public/assets/           Stylesheet and self-hosted fonts (Alegreya Sans, Fraunces; SIL OFL)
public/favicon.svg       Logo mark
tests/job-board.test.ts  Route, privacy, owner-gate, paging, spam-limit, and demo-removal tests
tests/helpers.ts         Test helpers built on the shared runtime harness
tests/demo.test.ts       Demo mode tests (delete with server/demo.js)
```

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /` | Everyone | Job board. Query: `q`, `category`, `type`, `after` (older jobs) |
| `GET /jobs/:id` | Everyone | Job page (live listings only) |
| `GET /post` | Everyone | Post a job form |
| `POST /post` | Everyone | Saves the listing as waiting for review |
| `GET /post/thanks` | Everyone | Confirmation |
| `GET /owner` | Owner | Listings by status. Query: `tab`, `after` (next page) |
| `GET /owner/jobs/:id` | Owner | Edit a listing |
| `POST /owner/jobs/:id` | Owner | Save edits |
| `POST /owner/jobs/:id/status` | Owner | Approve, decline, mark as filled, or put back live |
| `GET /owner/jobs/:id/delete` | Owner | "Delete this listing?" page |
| `POST /owner/jobs/:id/delete` | Owner | Delete a listing for good |
| `GET /owner/declined/delete` | Owner | "Delete declined listings?" page |
| `POST /owner/declined/delete` | Owner | Delete up to 15 declined listings per press |

Sign-in pages are provided by Userland at `/_userland/auth/login` and `/_userland/auth/logout`.

## Data

`listings` (read and write: server only)

| Field | Notes |
| --- | --- |
| `title`, `employer`, `location`, `pay`, `summary`, `description` | Shown publicly once approved |
| `category`, `job_type` | Checked against the lists in `server/listings.js` |
| `apply_link` | Email address or `https://` link, shown on the job page |
| `contact_name`, `contact_email` | Owner only, never on public pages |
| `status` | `pending`, `approved`, `rejected`, or `closed` |
| `featured`, `owner_note` | Owner only |
| `history` | Recent submitted/approved/edited entries for the activity panel |
| `submitted_at`, `published_at` | Dates used for sorting |

Why pages read so little: on Userland today every `list` call reads the whole collection before it filters, sorts, and returns up to 100 rows, and the Free plan gives each request 10 ms of CPU. Reading all 1,000 rows Free allows ten times over (once per 100 rows) would run past that. So each page makes at most two `list` calls, however many listings are saved:

- The public board reads one page of up to 100 live jobs, newest first. Category and schedule filters are part of that query (they're in the `by_status` index), so they cover every live job. Search words narrow down the page already read; when there are older jobs, the board says "Search looks through 100 jobs at a time" and "Older jobs" searches the next 100.
- A job page reads the job and up to four live jobs in the same category.
- The owner page reads the review queue (at most 100 listings, see `MAX_PENDING`) and the chosen tab's page of up to 100. "To review" always shows its count; the open tab shows one when its first page holds all of it, or "100+". Recent activity is built from the listings on the page.
- "Delete declined listings" makes one `list` call and up to 15 deletes.

The test "keeps each page to one or two full reads of the data, even with 1,000 listings" counts these calls. If you add a page, keep to the same budget: page through with the cursor instead of reading everything up front.

Categories and job types are plain strings validated in code, so you can change them without a data migration.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/job-board --message "First publish"
```

Then make yourself the owner. Create an app-user invite with the `owner` role and open the invite link it prints to set a password.

```sh
export APP_ID="<the app_id from the publish output>"
userland apps invites create "$APP_ID" --email you@yourfarm.com --role owner
```

`apps invites create` needs CLI 0.9.0 or later (`npm install -g @userland.fun/cli@latest` updates it). It uses the key saved by `userland login`, so there is no API key to make or revoke. It prints only the invite link, which works for 7 days (add `--expires-in-days 30` for longer). Give the link only to the owner: whoever has it can set the password once.

After that, `/owner` sends you to the sign-in page and back. Anyone without the `owner` role gets a "can't manage listings" page, and changes from signed-out visitors are refused.

Publish updates with `userland apps publish examples/job-board --app "$APP_ID" --message "..."`. If a release breaks something, list releases with `userland apps releases "$APP_ID"` and move back with `userland apps rollback "$APP_ID" "$RELEASE_ID"`. Rollback keeps your listings.

## Demo mode

The public demo lets anyone try the owner side without signing in. That code lives in `server/demo.js` and only switches on for the demo's two addresses, `job-board-demo.userland.link` and `4fz14jppml2y13cxqx1.userland.link` (`DEMO_HOSTS` in `demo.js`), so a copy published anywhere else always requires the owner sign-in.

How the demo keeps visitors apart: sample listings live in `demo.js`, not in your data. The first time a visitor posts a job or makes an owner change, they get a random key that stays in their page links (`?demo=...`). Userland only passes its own sign-in cookie through to server code, so a link key is used instead of a cookie. The visitor's listings, and their changes to sample listings, are saved in the `demo-listings` collection under that key. They stop showing after a day and are deleted the next time anyone uses the demo, up to five at a time on each page view or change, which keeps each request to a handful of data calls. Nobody without the key sees them. Anyone the visitor shares a link with gets the same key, so the banner says so.

Each key can save up to 30 changes. The whole demo keeps about 200 unexpired rows (`MAX_ACTIVE_ROWS`): once it's full, each new save deletes the oldest demo rows to make room, so a script that posts without a key can't fill the demo's storage or lock other visitors out; it only makes older demo changes disappear sooner. If many saves arrive at the same moment and push past the cap, the newest extra ones are taken back out, a few per save, and those visitors see a "The demo is busy, please try again in a minute" page until the demo is back under the cap. The same page shows if the demo app runs out of rows. A visitor past 30 changes is asked to start fresh in a private window. In the demo, "Delete declined listings" clears 10 per press.

Demo mode is meant only for the hosted demo; a real board has no reason to keep it.

To remove the demo:

1. Delete `server/demo.js`.
2. In `server/index.js`, delete the `import { demoMode } ...` line and change the last line to `export default createApp();`.
3. Delete the `demo-listings` collection from `manifest.userland.json`.
4. Delete `tests/demo.test.ts` (the demo tests).

The "removing the demo" test in `tests/job-board.test.ts` runs steps 1 to 3 on a copy of `server/` and the manifest and checks that posting, review, and the public board still work. The rest of `tests/job-board.test.ts` and `tests/helpers.ts` never touch demo mode, so `npx vitest run examples/job-board` passes after all four steps.

## Plan notes

The manifest fits the Free plan: server routes, app-user auth with one role, and two data collections (one if you remove the demo). Things that need a paid plan:

- Your own domain, or a short address like `yourboard.userland.link`: Starter.
- App Analytics (visits, top pages, referrers) in the console: Starter.
- Free includes 1,000 saved rows per app (demo rows count too if you keep demo mode) and 10,000 requests a month across your whole account. Listings stay saved after they're declined or filled, so delete old ones from the owner page now and then. If the board does fill up, posting shows a "new listings are paused" page and the owner page says how to make room. A busy board will want Starter.

## Abuse protection

- Every field has a length limit, and category, schedule, email, and apply link are checked on the server.
- A hidden "website" field catches form-filling bots; those submissions are dropped quietly.
- At most 100 listings can wait for review at once (`MAX_PENDING` in `server/listings.js`). Past that, the form shows "New listings are paused for now" until the owner works through the queue.
- One contact email can have at most 3 listings waiting for review (`MAX_PENDING_PER_EMAIL`). Someone can get around this by using another address, but the 100-listing queue limit still holds.
- Both limits are checked before saving and again right after, so a burst of posts at the same moment is turned away too. They are soft limits: a post saved in the very same instant as another can occasionally slip one past.
- The owner can delete any listing, and clear out declined ones 15 at a time, so a wave of spam can be removed from the owner page.
- Email addresses may only use letters, digits, and `. _ + ' -` before the `@`, so an apply address can't slip extra recipients (like `?bcc=`) into the "Email the employer" link.
- All visitor text is escaped before it goes on a page, and pages send a strict Content Security Policy.
- New listings stay off the board until the owner approves them.
- Every form post must come from the board's own pages (the `Origin` header has to match), so a page on another site, including other `*.userland.link` apps, can't approve, edit, or delete listings while you're signed in.

## Test

```sh
npx vitest run examples/job-board
```

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

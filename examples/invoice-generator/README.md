# Invoice Generator

Quotes and invoices for a small service business. Clients request a quote from a public page, the owner prices it with line items, sends a private link, and turns the accepted quote into a printable invoice.

Live demo: https://invoice-demo.apps.userland.fun/ (a made-up design and photography studio, Kern & Frame)
Example page: https://userland.fun/examples/invoice-generator/

## What it does

For the business's clients (no account needed):

- A studio page with services and a **Request a quote** form (`/`).
- A private link for each sent quote or invoice (`/p/:token`) that shows a clean, printable document. Clients can accept or decline a sent quote there, and print or save it as a PDF.

For the owner (app user with the `owner` role):

- **Documents** (`/desk`): totals for outstanding, overdue, open quotes, and paid in the last 30 days; new quote requests; every quote and invoice with its status, 50 per page, newest first. Tabs show all documents, quotes (new requests have their own tab), invoices, or requests.
- **Clients** (`/desk/clients`): add and edit clients with a billing address. A client with no quotes or invoices can be deleted.
- **Quotes and invoices** (`/desk/new`, `/desk/documents/:id`): line items with quantity and price, tax, totals, terms, and dates. Status moves from draft to sent to accepted or paid, and an accepted quote becomes an invoice in one click. A document needs at least one priced line before it can be sent or invoiced.
- **Spam clean-up**: a new request (or a quote that was never sent) can be deleted. Deleting a request also deletes its client when they have nothing else on file.

## Plan

Publishes on the **Free** plan. The manifest uses app-user auth with one role (`owner`, no public signup), two data collections with two indexes each (the Free plan's limits), and one manual job. No secrets, files, webhooks, or scheduled jobs. A custom domain or a named address such as `invoice-demo.apps.userland.fun` is an account feature on paid plans; the app itself doesn't need one.

## How it's built

```
manifest.userland.json   app, runtime, auth, data, and the demo cleanup job
public/                  CSS, a small script, favicon, and the Archivo font (SIL OFL)
server/index.js          routes, owner gate, and request handling
server/store.js          data access, validation, status rules, and money math
server/views.js          server-rendered HTML for every page
server/studio.js         business details: name, address, currency, numbering, services
server/demo.js           demo mode for the public demo only (see below)
tests/                   vitest tests on the shared fake runtime (scripts/runtime-harness.ts); demo.test.ts covers demo mode only
```

- **Server-rendered pages.** Every page is plain HTML from `server/views.js` and works without JavaScript. `public/assets/app.js` only adds live totals, extra line rows, copy, and print buttons.
- **Money in cents.** Prices are parsed to whole cents on the server; totals are computed there with whole-number math (half a cent rounds up, as in a spreadsheet) and stored with each document, so a printed invoice never depends on browser math. Each document keeps the currency it was saved with.
- **Two collections.** `clients` and `documents`. Quotes and invoices share `documents` (`kind` is `quote` or `invoice`) and keep line items in a `json` field, which keeps the app inside the Free plan's two-collection limit.
- **Status rules** live in `TRANSITIONS` in `server/store.js`. A client can't accept a quote after its "valid until" date.
- **Unique indexes, not read-then-write.** Two requests can arrive at the same moment (a double click, two tabs, two visitors), so the rules that must always hold are unique indexes that Userland enforces on every write: `clients.by_email` (one client per email) and `documents.by_number` (one document per number). A clashing write throws `unique_conflict`; the code catches it and picks the next number or reuses the existing client. Converting a quote uses the same index: the new invoice is first saved under a placeholder number made from the quote's id, so a second conversion of the same quote clashes and opens the first invoice instead (see `convertQuote`). `ctx.data.transaction` doesn't stop two requests from interleaving, so nothing here relies on it for that.
- **Lists that don't stop at one page.** `where` and `order_by` fields must be in an index; `documents.for_lists` holds the fields the desk filters and sorts on. Desk totals read every row of each status they count, and long lists show 50 rows with a link to the next page.
- **Private client links** use a random 24-character token. Drafts and new requests are never visible through a link.
- **App events.** Requests, new documents, status changes, client answers, and conversions are logged with `ctx.log.info` using ids and numbers only, never emails or names. Read them with `userland apps events <app-id>`.
- **Safety.** All output is escaped, inputs have length limits (a form body over 64 KB is refused even without a `Content-Length`), and pages send a strict Content-Security-Policy. Form posts must come from this app's own pages: every app on `*.apps.userland.fun` counts as the same site for cookies, so the `Origin` header has to match exactly (`null` and other Userland apps are refused), with `Sec-Fetch-Site` as a fallback. Desk forms need one of the two.
- **Spam and storage limits.** The public form has a hidden honeypot field and caps in `LIMITS` (`server/store.js`): no new requests while 50 are waiting for a reply, or while one email address has 3 waiting. The caps hold when a bot sends many requests at the same moment: each request counts again after it is saved and takes itself (and a client it just added) back out if it went over, so refused requests leave no rows behind (see `createRequest`). When so many arrive at once that no free number is found, the visitor is asked to send again. Userland doesn't pass visitor IP addresses to app code, so there is no per-address limit. A request that uses a known client's email with a different name is flagged on the desk. If the app reaches its plan's row limit, visitors and the owner see a plain "can't be saved right now" page instead of an error; delete spam requests to make room.

## The owner sign-in

`/desk` routes call `ctx.auth.requireRole(request, "owner")`. A signed-out visitor is sent to Userland's sign-in page (`/_userland/auth/login`); a signed-in user without the role gets a 403. Public signup is off, so the owner is invited after the first publish.

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/invoice-generator --message "First release"
```

The invite is an API request, so it needs an API key in `USERLAND_API_KEY`. `userland login` keeps its key in `~/.userland/credentials.json`, not in your shell, so create a key for the invite (the CLI shows it once, under `API key:`) and put it and the app id in your environment:

```sh
userland auth api-keys create --name "invoice-generator owner invite"
export USERLAND_API_KEY="<the key printed under API key:>"
export APP_ID="<the app_id from the publish output>"

curl -fsS -X POST \
  -H "authorization: Bearer $USERLAND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","roles":["owner"]}' \
  "https://api.userland.fun/v0/apps/$APP_ID/admin-invites"
```

The response includes an `invite_url` where the owner sets a password and signs in. Run these commands in your own terminal; the API key never goes into the app. Once the owner has signed in, run `unset USERLAND_API_KEY` (CLI commands use that variable before your saved login), then revoke the invite key with `userland auth api-keys revoke <api-key-id>` (the id is printed as `Created API key ...`).

See https://docs.userland.fun/guides/auth for invites and sessions.

## Demo mode

`server/demo.js` powers the public demo. It is active only on the hosts listed in `DEMO_HOSTS` (`invoice-demo.apps.userland.fun`), so a copy published anywhere else always requires the owner sign-in. On the demo app's own Userland address (`SHOWCASE_HOSTS`), public pages redirect to the demo address and `/desk` keeps the normal owner sign-in.

On the demo host, anyone can open the studio desk. Each visitor gets a private workspace named by a random key in the page address (`?demo=...`), filled with fictional sample clients and documents. Userland only passes its own sign-in cookie to app code, so the key travels in links and forms instead of a cookie. Visitors only ever see their own workspace, and the `clear-demo` job deletes it six hours later.

Only keys the server handed out work: a key starts with the time it was issued, and its workspace must exist, so a made-up or expired key shows the start page and stores nothing. The cleanup job is scheduled before a workspace is created (no job, no workspace). At most 50 demo desks are open at once, even when many visitors start together (each new desk counts again once its first sample is saved and clears itself if it went over). When all 50 are taken, a new visitor's desk replaces the oldest one that has been open for at least an hour, so a burst of new desks can't lock the demo for six hours. Each visitor's desk stops at 25 clients and 40 documents. Each `clear-demo` run also reads every row and deletes up to 60 left behind by expired workspaces whose own cleanup never ran.

To remove demo mode from your copy:

1. Delete `server/demo.js` and `tests/demo.test.ts`.
2. In `server/index.js`, delete every line that ends with `// demo`.
3. In `manifest.userland.json`, delete the `jobs` section (the `clear-demo` job).

The `workspace` field can stay; all real data lives in the `main` workspace. The "removing demo mode" test in `tests/invoice-generator.test.ts` runs exactly these steps on a copy of `server/` and checks that every page still works, and that no other test in that file depends on the demo, so the remaining tests pass after the steps. Keep lines you add for the demo marked the same way, and put demo tests in `tests/demo.test.ts`.

## Adapt it

- Change the business details, currency, time zone, numbering, and services in `server/studio.js`. The time zone decides the date on new documents and when an invoice counts as overdue.
- Amounts are stored in hundredths, so pick a currency with two decimal places (USD, EUR, GBP, CAD, AUD, and most others; not JPY or KRW). Prices are typed like `1,250.50`, with an optional currency sign in front. Changing the currency later only affects new documents.
- Change the spam caps and page size in `LIMITS` at the top of `server/store.js`.
- Change copy and layout in `server/views.js` and colors in the `:root` tokens at the top of `public/assets/app.css`.
- Payment or email later: add a provider key with `userland apps secrets set` and read it only in server code with `ctx.secrets.require(...)`. Never put keys in `public/`.

## Test

```sh
npx vitest run examples/invoice-generator
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
- Jobs: https://docs.userland.fun/guides/jobs
- Rollback: https://docs.userland.fun/guides/rollback

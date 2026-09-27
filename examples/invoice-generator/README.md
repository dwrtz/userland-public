# Invoice Generator

Quotes and invoices for a small service business. Clients request a quote from a public page, the owner prices it with line items, sends a private link, and turns the accepted quote into a printable invoice.

Live demo: https://invoice-demo.apps.userland.fun/ (a made-up design and photography studio, Kern & Frame)
Example page: https://userland.fun/examples/invoice-generator/

## What it does

For the business's clients (no account needed):

- A studio page with services and a **Request a quote** form (`/`).
- A private link for each sent quote or invoice (`/p/:token`) that shows a clean, printable document. Clients can accept or decline a sent quote there, and print or save it as a PDF.

For the owner (app user with the `owner` role):

- **Documents** (`/desk`): totals for outstanding, overdue, open quotes, and paid in the last 30 days; new quote requests; every quote and invoice with its status.
- **Clients** (`/desk/clients`): add and edit clients with a billing address.
- **Quotes and invoices** (`/desk/new`, `/desk/documents/:id`): line items with quantity and price, tax, totals, terms, and dates. Status moves from draft to sent to accepted or paid, and an accepted quote becomes an invoice in one click.

## Plan

Publishes on the **Free** plan. The manifest uses app-user auth with one role (`owner`, no public signup), two data collections with two indexes each, and one manual job. No secrets, files, webhooks, or scheduled jobs. A custom domain or a named address such as `invoice-demo.apps.userland.fun` is an account feature on paid plans; the app itself doesn't need one.

## How it's built

```
manifest.userland.json   app, runtime, auth, data, and the demo cleanup job
public/                  CSS, a small script, favicon, and the Archivo font (SIL OFL)
server/index.js          routes, owner gate, and request handling
server/store.js          data access, validation, status rules, and money math
server/views.js          server-rendered HTML for every page
server/studio.js         business details: name, address, currency, numbering, services
server/demo.js           demo mode for the public demo only (see below)
tests/                   vitest tests on the shared fake runtime (scripts/runtime-harness.ts)
```

- **Server-rendered pages.** Every page is plain HTML from `server/views.js` and works without JavaScript. `public/assets/app.js` only adds live totals, extra line rows, copy, and print buttons.
- **Money in cents.** Prices are parsed to whole cents on the server; totals are computed there and stored with each document, so a printed invoice never depends on browser math.
- **Two collections.** `clients` and `documents`. Quotes and invoices share `documents` (`kind` is `quote` or `invoice`) and keep line items in a `json` field, which keeps the app inside the Free plan's two-collection limit.
- **Status rules** live in `TRANSITIONS` in `server/store.js`. Converting a quote runs in `ctx.data.transaction` so it happens once.
- **Private client links** use a random token with a unique index. Drafts and new requests are never visible through a link.
- **App events.** Requests, new documents, status changes, client answers, and conversions are logged with `ctx.log.info` using ids and numbers only, never emails or names. Read them with `userland apps events <app-id>`.
- **Safety.** All output is escaped, inputs have length limits, the public form has a hidden honeypot field, cross-site form posts are refused, and pages send a strict Content-Security-Policy.

## The owner sign-in

`/desk` routes call `ctx.auth.requireRole(request, "owner")`. A signed-out visitor is sent to Userland's sign-in page (`/_userland/auth/login`); a signed-in user without the role gets a 403. Public signup is off, so the owner is invited after the first publish:

```sh
userland apps publish examples/invoice-generator --message "First release"

curl -fsS -X POST \
  -H "authorization: Bearer $USERLAND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","roles":["owner"]}' \
  "https://api.userland.fun/v0/apps/$APP_ID/admin-invites"
```

The response includes an `invite_url` where the owner sets a password and signs in. Run the curl from your own terminal; the API key never goes into the app.

See https://docs.userland.fun/guides/auth for invites and sessions.

## Demo mode

`server/demo.js` powers the public demo. It is active only on the hosts listed in `DEMO_HOSTS` (`invoice-demo.apps.userland.fun`), so a copy published anywhere else always requires the owner sign-in. On the demo app's own Userland address (`SHOWCASE_HOSTS`), public pages redirect to the demo address and `/desk` keeps the normal owner sign-in.

On the demo host, anyone can open the studio desk. Each visitor gets a private workspace named by a random key in the page address (`?demo=...`), filled with fictional sample clients and documents. Userland only passes its own sign-in cookie to app code, so the key travels in links and forms instead of a cookie. Visitors only ever see their own workspace, and the `clear-demo` job deletes it six hours later.

To remove demo mode from your copy:

1. Delete `server/demo.js`.
2. In `server/index.js`, delete every line that ends with `// demo`.
3. In `manifest.userland.json`, delete the `jobs` section (the `clear-demo` job).

The `workspace` field can stay; all real data lives in the `main` workspace. The "removing demo mode" test in `tests/` runs exactly these steps on a copy of `server/` and checks that every page still works, so keep lines you add for the demo marked the same way.

## Adapt it

- Change the business details, currency, time zone, numbering, and services in `server/studio.js`. The time zone decides the date on new documents and when an invoice counts as overdue.
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

# Agent notes

Goal: adapt a commerce-like app with data, files, secrets, jobs, and webhooks.

Plan: `required_plan` is `business`. `paid_features`:

- Business: `auth.public_signup`, `jobs.schedule.allowed` (the `hourly` schedule; Starter allows `daily` only).
- Starter: `data.collections.max` (4 collections), `data.indexes_per_collection.max` (3 on `orders`), `files.max_upload_size_bytes.max` (10 MB), `secrets.required.max` (2), `jobs.scheduled`, `jobs.declared.max` (2), `webhooks.enabled`, `webhooks.provider.stripe`, `webhooks.declared.max` (1).

Setting `public_signup: false` and `schedule: "daily"` brings it to `starter`. Keep `required_plan` and `paid_features` in `example.json` and `catalog.json` in sync with the manifest.

Inputs:

- Product model.
- Order lifecycle.
- Which Stripe Checkout events mark an order paid.

Outputs:

- Manifest resources for products, orders, stock updates, handled Stripe events, images, secrets, jobs, and the Stripe webhook.
- Storefront UI under `public/`.
- Server routes and job handlers in `server/index.js`.

Steps:

1. Rename app metadata and tags.
2. Adjust product and order fields. Filter and sort only on indexed fields (`slug`, `status`, `checkout_session_id`, `app_user_id`, `event_id`, `handled_at`).
3. Replace the stand-in checkout in `createOrder` with Stripe's Checkout Sessions API, reading the Stripe secret key with `ctx.secrets.get("CHECKOUT_SECRET_KEY")` and returning 503 when it is missing (`ctx.secrets.require` throws instead, and the visitor gets the platform's `400 missing_secret`). Build the session's lines from `priceLineItems`, never from the request, and store the session's `id` (`cs_...`) as the order's `checkout_session_id`.
4. Keep pricing and stock on the server: `priceLineItems` reads prices and `inventory_count` from `products`, never from the request, adds up lines for the same product, and answers `409 out_of_stock` for more than is in stock. `takeFromStock` lowers stock when an order is paid, once per order: the job first creates a `stock-updates` row, and its unique `by_order` index turns a retried or simultaneous second delivery of the same payment into `unique_conflict`, which is skipped. Create that row after marking the order paid, so a job that failed earlier still takes stock off on its retry. If taking stock fails, the job logs `stock not updated` and does not retry. Two different orders paid at the same moment can still both read the same count (the read-then-write on `inventory_count` is not atomic); the job logs `order oversold` instead of going below zero.
5. The `checkout` webhook is `"provider": "stripe"`: Userland checks Stripe's `Stripe-Signature` header with `CHECKOUT_WEBHOOK_SECRET` (the endpoint's signing secret, `whsec_...`) before the app sees anything, so there is no relay and the app never checks signatures itself. It needs CLI 0.11.0 or later; older CLIs refuse it with `message=must be "none"` for `resources.webhooks.checkout.provider` (update with `npm install -g @userland.fun/cli@latest`). The owner adds `https://<app-id>.apps.userland.fun/_userland/webhooks/checkout` in Stripe's webhook settings with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`, then saves the signing secret Stripe shows as `CHECKOUT_WEBHOOK_SECRET` and the app is published again with `--app`. Never print or log the signing secret.
   Stripe's test and live modes have separate endpoints and signing secrets, and the app checks one `CHECKOUT_WEBHOOK_SECRET` at a time. When the shop goes live, the owner adds the endpoint in live mode with the same events, saves its signing secret as `CHECKOUT_WEBHOOK_SECRET` (replacing the test one) and the live secret key as `CHECKOUT_SECRET_KEY`, then disables or deletes the test-mode endpoint, whose messages Userland now turns away.
   Webhook-delivered jobs receive `event.payload = { webhook_delivery_id, name, headers, payload }`; Stripe's event is `event.payload.payload` (`id`, `type`, `data.object`), and the `Stripe-Signature` header is not passed on.
   The job finds the order by the session's `id` and acts only when `amount_total` equals `total_cents` and `currency` matches. Only a `checkout.session.completed` or `checkout.session.async_payment_succeeded` event whose session has `payment_status: "paid"` marks an order paid. A `checkout.session.completed` with `payment_status: "unpaid"` is a bank payment that takes days: it moves a `checkout_pending` order to `payment_processing`, which the hourly job does not cancel, until `checkout.session.async_payment_succeeded` marks it paid or `checkout.session.async_payment_failed` cancels it. Keep these checks: Stripe sends expired, failed, and still-processing events for the same session. A payment for a cancelled order is logged as a warning, never applied.
   Keep the handler idempotent: Stripe retries, and an event can be resent. Userland answers a repeat within 10 minutes of delivering it once; after that, the job's `handled-events` collection (unique `by_event_id`) remembers each event id that paid an order, and the job ignores it next time. Remember the id only after the order is paid and stock is taken off, so a job that failed still handles the event when it is retried. Stripe retries for up to 3 days and keeps events for 30, so the hourly job deletes `handled-events` rows older than 30 days (oldest first by the `by_handled_at` index, at most 500 a run) to keep them from counting toward the app's row limit; an older event sent again finds its order paid and its `stock-updates` row, and takes no stock off.
6. Keep the same-origin check (`isSameOrigin`) in front of every POST and `readJson` requiring `content-type: application/json`. The sign-in cookie is SameSite=Lax and every `*.apps.userland.fun` app is the same site, so without the check a page on another app could auto-submit a hidden `text/plain` form that creates products or orders as a signed-in admin or customer.
7. Open sign-up gives new customers no roles (roles come only from invites), so do not gate ordering on a role. `createOrder` only needs a signed-in user, and `MAX_OPEN_ORDERS_PER_CUSTOMER` (5) caps open checkouts (`checkout_pending` orders) per customer; it is a brake, not a lock, since two simultaneous orders can both pass it.
8. `createProduct` maps the `by_slug` unique index's `unique_conflict` error to `409 slug_taken`. Keep list routes paginated with `cursor`; do not raise `limit` to hide pagination.
9. Keep job names identical in `resources.jobs`, `resources.webhooks.checkout.job`, and `job(event, ctx)`.
10. Validate: `npm run validate:manifests -- tiny-store` and `npx vitest run examples/tiny-store`.
11. The first publish creates the app, but its release stays `pending_secrets` and is not live. Setting secrets does not activate it. The payment provider's keys are the owner's: send them `https://console.userland.fun/apps/<app-id>/settings?add-key=CHECKOUT_SECRET_KEY` and `https://console.userland.fun/apps/<app-id>/settings?add-key=CHECKOUT_WEBHOOK_SECRET`, where they paste and save each one, instead of asking for them in chat. If you already have a value, or the console says it can't save keys right now, set it with `printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>` without printing it. Then publish again into the same app with `userland apps publish examples/tiny-store --app <app-id>` (without `--app` the CLI creates a second app). Then invite an admin.

Safety:

- Never return, log, or embed any part of a secret, including prefixes.
- Do not trust client-submitted totals, prices, or user ids.
- Do not mark orders paid from public routes; only the webhook job does that, and only for a fully paid checkout.
- Never log or store the `Stripe-Signature` header.
- Check order ownership (or the `admin` role) before showing an order, and escape values in server-rendered HTML.

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
- Files: https://docs.userland.fun/guides/files
- Secrets: https://docs.userland.fun/guides/secrets
- Jobs: https://docs.userland.fun/guides/jobs
- Webhooks: https://docs.userland.fun/guides/webhooks
- Rollback: https://docs.userland.fun/guides/rollback

# Agent notes

Goal: adapt a commerce-like app with data, files, secrets, jobs, and webhooks.

Plan: `required_plan` is `business`. `paid_features`:

- Business: `auth.public_signup`, `jobs.schedule.allowed` (the `hourly` schedule; Starter allows `daily` only).
- Starter: `data.indexes_per_collection.max` (3 on `orders`), `files.max_upload_size_bytes.max` (10 MB), `secrets.required.max` (2), `jobs.scheduled`, `jobs.declared.max` (2), `webhooks.enabled`, `webhooks.provider.generic_hmac`, `webhooks.declared.max` (1).

Setting `public_signup: false` and `schedule: "daily"` brings it to `starter`. Keep `required_plan` and `paid_features` in `example.json` and `catalog.json` in sync with the manifest.

Inputs:

- Product model.
- Order lifecycle.
- Checkout provider requirements.
- Webhook payload shape.

Outputs:

- Manifest resources for products, orders, images, secrets, jobs, and webhooks.
- Storefront UI under `public/`.
- Server routes and job handlers in `server/index.js`.

Steps:

1. Rename app metadata and tags.
2. Adjust product and order fields. Filter and sort only on indexed fields (`slug`, `status`, `checkout_session_id`, `app_user_id`).
3. Replace the mock checkout in `createOrder` with the provider's server API, reading the key with `ctx.secrets.get("CHECKOUT_SECRET_KEY")` and returning 503 when it is missing (`ctx.secrets.require` throws instead, and the visitor gets the platform's `400 missing_secret`).
4. Keep pricing and stock on the server: `priceLineItems` reads prices and `inventory_count` from `products`, never from the request, adds up lines for the same product, and answers `409 out_of_stock` for more than is in stock. `takeFromStock` lowers stock when an order is paid. That read-then-write is not atomic across concurrent jobs; it logs `order oversold` instead of going below zero.
5. Real payment providers use their own signature schemes, which the `generic_hmac` webhook rejects. Relay provider events through a service that verifies them and re-signs in Userland's format (`X-Userland-Timestamp`, `X-Userland-Signature` = hex HMAC-SHA256 of timestamp + raw body); see the README.
   Webhook-delivered jobs receive `event.payload = { webhook_delivery_id, name, headers, payload }`; the provider's body is `event.payload.payload`. Keep the handler idempotent: providers retry.
   Only `{ type: "checkout.completed", payment_status: "paid", checkout_session_id, amount_total, currency }` marks an order paid, and only when `amount_total` equals `total_cents` and `currency` matches. Keep that check when you map your provider's events: providers send expired, failed, and still-processing events for the same session, and a completed checkout with a delayed payment method arrives unpaid. A payment for a cancelled order is logged as a warning, never applied.
6. Keep the same-origin check (`isSameOrigin`) in front of every POST and `readJson` requiring `content-type: application/json`. The sign-in cookie is SameSite=Lax and every `*.apps.userland.fun` app is the same site, so without the check a page on another app could auto-submit a hidden `text/plain` form that creates products or orders as a signed-in admin or customer.
7. Open sign-up gives new customers no roles (roles come only from invites), so do not gate ordering on a role. `createOrder` only needs a signed-in user, and `MAX_OPEN_ORDERS_PER_CUSTOMER` (5) caps unpaid orders per customer; it is a brake, not a lock, since two simultaneous orders can both pass it.
8. `createProduct` maps the `by_slug` unique index's `unique_conflict` error to `409 slug_taken`. Keep list routes paginated with `cursor`; do not raise `limit` to hide pagination.
9. Keep job names identical in `resources.jobs`, `resources.webhooks.checkout.job`, and `job(event, ctx)`.
10. Validate: `npm run validate:manifests -- tiny-store` and `npx vitest run examples/tiny-store`.
11. The first publish creates the app, but its release stays `pending_secrets` and is not live. Setting secrets does not activate it. Set both secrets with `printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>`, then publish again into the same app with `userland apps publish examples/tiny-store --app <app-id>` (without `--app` the CLI creates a second app). Then invite an admin.

Safety:

- Never return, log, or embed any part of a secret, including prefixes.
- Do not trust client-submitted totals, prices, or user ids.
- Do not mark orders paid from public routes; only the webhook job does that, and only for a completed, fully paid checkout.
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

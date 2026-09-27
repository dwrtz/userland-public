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
3. Replace the mock checkout in `createOrder` with the provider's server API, reading the key with `ctx.secrets.get("CHECKOUT_SECRET_KEY")` and returning 503 when it is missing (`ctx.secrets.require` throws instead, which the runtime turns into a 500).
4. Keep pricing on the server: `priceLineItems` reads prices from `products`, never from the request.
5. Real payment providers use their own signature schemes, which the `generic_hmac` webhook rejects. Relay provider events through a service that verifies them and re-signs in Userland's format (`X-Userland-Timestamp`, `X-Userland-Signature` = hex HMAC-SHA256 of timestamp + raw body); see the README.
   Webhook-delivered jobs receive `event.payload = { webhook_delivery_id, name, headers, payload }`; the provider's body is `event.payload.payload`. Keep the handler idempotent: providers retry.
6. Keep job names identical in `resources.jobs`, `resources.webhooks.checkout.job`, and `job(event, ctx)`.
7. Validate: `npm run validate:manifests -- tiny-store` and `npx vitest run examples/tiny-store`.
8. The first publish creates the app, but its release stays `pending_secrets` and is not live. Setting secrets does not activate it. Set both secrets with `printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>`, then publish again into the same app with `userland apps publish examples/tiny-store --app <app-id>` (without `--app` the CLI creates a second app). Then invite an admin.

Safety:

- Never return, log, or embed any part of a secret, including prefixes.
- Do not trust client-submitted totals, prices, or user ids.
- Do not mark orders paid from public routes; only the webhook job does that.
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

# Tiny Store

A small shop: admins add products, signed-in customers place orders, and a payment provider confirms payment through a webhook.

## What it shows

- Server routes for products, orders, and order pages.
- App sign-in with an `admin` role, and open sign-up for customers. New customers get no role; any signed-in customer can order.
- `products` and `orders` data collections. Order totals are worked out on the server from product prices. A small `stock-updates` collection makes sure each paid order takes stock off only once.
- Stock: an order can't ask for more than a product's `inventory_count`, and stock goes down when the payment is confirmed. Shoppers see "Sold out", not the exact count.
- A customer can have at most 5 unpaid orders open at once.
- The product list comes 50 at a time with a "Show more" button.
- Shop actions only work from the shop's own pages. Another site, including another app on `apps.userland.fun`, cannot post to them on a signed-in admin's or customer's behalf.
- A public `product-images` file store.
- Two server-only secrets for the payment provider.
- A webhook that hands verified payment events to a background job.
- An hourly job that cancels checkouts left unpaid for 24 hours.

Checkout is a stand-in. Replace it with your payment provider's server-side API before taking real payments.

## Plan

**Plan needed: Business.** This example is intentionally paid.

- Business: open customer sign-up, and the hourly job (Starter allows daily jobs only).
- Starter or higher: the payment webhook, a second secret, a second job, a scheduled job, a third data collection, a third index on orders, and image uploads up to 10 MB.

To fit Starter, turn off open sign-up and run the cleanup job daily. Run `userland accounts limits` to see your account's current limits.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/tiny-store
```

The first publish creates the app and prints its app id. That release is not live yet: its activation status is `pending_secrets` because the two secrets are missing. Setting secrets does not activate a stored release, so set both and then publish again into the same app:

```sh
printf '%s' "$CHECKOUT_SECRET_KEY" | userland apps secrets set <app-id> CHECKOUT_SECRET_KEY
printf '%s' "$CHECKOUT_WEBHOOK_SECRET" | userland apps secrets set <app-id> CHECKOUT_WEBHOOK_SECRET
userland apps publish examples/tiny-store --app <app-id>
```

You can add the keys in the console instead: open `https://console.userland.fun/apps/<app-id>/settings?add-key=CHECKOUT_SECRET_KEY` and `https://console.userland.fun/apps/<app-id>/settings?add-key=CHECKOUT_WEBHOOK_SECRET`, paste each key, and save it, then publish again with `--app` as above. A coding agent setting up the app for you sends you these links rather than asking you to paste the keys into your chat.

Always pass `--app <app-id>` when publishing again. Without it, the CLI creates a second app.

Then invite the first admin and add products:

```sh
userland apps invites create <app-id> --email admin@example.com --role admin
```

It prints the invite link; give it only to that person. `apps invites create` needs CLI 0.9.0 or later and uses the key saved by `userland login`. See https://docs.userland.fun/guides/auth for invites.

## Payment webhook

Payment confirmations arrive at:

```text
https://<app-id>.apps.userland.fun/_userland/webhooks/checkout
```

Userland checks every request before the app sees it, using the `generic_hmac` scheme:

- `X-Userland-Timestamp`: the current Unix time in seconds. Requests more than 5 minutes off are rejected.
- `X-Userland-Signature`: the hex HMAC-SHA256 of the timestamp followed directly by the raw request body, keyed with ``CHECKOUT_WEBHOOK_SECRET``. A `sha256=` prefix is optional.

Missing or wrong headers are rejected with a 400 or 401 and never reach the app.

Only one event marks an order paid. Its JSON body must look like this, with the `checkout_session_id` returned when the order was created and the amount in cents:

```json
{
  "type": "checkout.completed",
  "checkout_session_id": "<checkout-session-id>",
  "payment_status": "paid",
  "amount_total": 2400,
  "currency": "usd"
}
```

Every other event is logged and ignored: expired or abandoned checkouts, failed payments, and completed checkouts whose payment is still processing (`payment_status` other than `paid`). An amount or currency that doesn't match the order is ignored with a warning. A payment that arrives after the hourly job cancelled the order is left alone with a `payment received for cancelled order` warning, so you can refund it or restore the order yourself. Find these with `userland apps events <app-id> --severity warn`.

Payment providers sign their webhooks with their own schemes, so you cannot point a provider straight at this URL. Relay the provider's events through a small service that checks the provider's own signature, turns a successful payment into the body above, re-signs it in the format above, and forwards it here. The Webhooks guide lists the other signing schemes Userland accepts.

Stock is taken off once per order when the payment is confirmed, even if the payment event arrives twice. Payments for two different orders confirmed at the same moment can miss each other's change, and a payment for the last items can arrive after someone else's; the job logs an `order oversold` warning when stock would go below zero. If stock can't be updated at all, the job logs a `stock not updated` error; adjust the product's stock by hand.

## Troubleshoot or undo

```sh
userland apps events <app-id> --severity error --limit 25
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
```

Rollback changes which release is live. Products, orders, customers, files, and secrets are kept.

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

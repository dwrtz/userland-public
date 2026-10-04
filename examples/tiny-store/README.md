# Tiny Store

A small shop: admins add products, signed-in customers place orders, and Stripe confirms payment through a webhook.

## What it shows

- Server routes for products, orders, and order pages.
- App sign-in with an `admin` role, and open sign-up for customers. New customers get no role; any signed-in customer can order.
- `products` and `orders` data collections. Order totals are worked out on the server from product prices. A small `stock-updates` collection makes sure each paid order takes stock off only once, and `handled-events` remembers which Stripe events the shop has handled in the last 30 days.
- Stock: an order can't ask for more than a product's `inventory_count`, and stock goes down when the payment is confirmed. Shoppers see "Sold out", not the exact count.
- A customer can have at most 5 unpaid checkouts open at once.
- The product list comes 50 at a time with a "Show more" button.
- Shop actions only work from the shop's own pages. Another site, including another app on `apps.userland.fun`, cannot post to them on a signed-in admin's or customer's behalf.
- A public `product-images` file store.
- Two server-only secrets for Stripe.
- A Stripe webhook: Userland checks Stripe's signature, then hands the payment event to a background job.
- An hourly job that cancels checkouts left unpaid for 24 hours (orders waiting on a bank payment are left for Stripe's answer) and forgets handled Stripe events after 30 days.

Checkout is a stand-in: placing an order makes up a checkout session ID. Before taking real payments, replace it with a call to Stripe's Checkout Sessions API with `CHECKOUT_SECRET_KEY`, and store the session's `id` (`cs_...`) as the order's `checkout_session_id`, so Stripe's payment event finds the order.

## Plan

**Plan needed: Business.** This example is intentionally paid.

- Business: open customer sign-up, and the hourly job (Starter allows daily jobs only).
- Starter or higher: the Stripe webhook, a second secret, a second job, a scheduled job, a third and fourth data collection, a third index on orders, and image uploads up to 10 MB.

To fit Starter, turn off open sign-up and run the cleanup job daily. Run `userland accounts limits` to see your account's current limits.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/tiny-store
```

The webhook's `"provider": "stripe"` needs CLI 0.11.0 or later. Older versions of `userland validate` and `apps publish` refuse it with `manifest_path=resources.webhooks.checkout.provider` and `message=must be "none"`; `npm install -g @userland.fun/cli@latest` updates the CLI.

The first publish creates the app and prints its app id. That release is not live yet: its activation status is `pending_secrets` because the two secrets are missing. Add the payment webhook in Stripe (below) to get its signing secret. Setting secrets does not activate a stored release, so set both and then publish again into the same app:

```sh
printf '%s' "$CHECKOUT_SECRET_KEY" | userland apps secrets set <app-id> CHECKOUT_SECRET_KEY
printf '%s' "$CHECKOUT_WEBHOOK_SECRET" | userland apps secrets set <app-id> CHECKOUT_WEBHOOK_SECRET
userland apps publish examples/tiny-store --app <app-id>
```

`CHECKOUT_SECRET_KEY` is your Stripe secret key, for when you replace the stand-in checkout. `CHECKOUT_WEBHOOK_SECRET` is the signing secret Stripe shows for the payment webhook (`whsec_...`).

You can add the keys in the console instead: open `https://console.userland.fun/apps/<app-id>/settings?add-key=CHECKOUT_SECRET_KEY` and `https://console.userland.fun/apps/<app-id>/settings?add-key=CHECKOUT_WEBHOOK_SECRET`, paste each key, and save it, then publish again with `--app` as above. A coding agent setting up the app for you sends you these links rather than asking you to paste the keys into your chat.

Always pass `--app <app-id>` when publishing again. Without it, the CLI creates a second app.

Then invite the first admin and add products:

```sh
userland apps invites create <app-id> --email admin@example.com --role admin
```

It prints the invite link; give it only to that person. `apps invites create` needs CLI 0.9.0 or later and uses the key saved by `userland login`. See https://docs.userland.fun/guides/auth for invites.

## Payment webhook

Stripe sends payment events straight to:

```text
https://<app-id>.apps.userland.fun/_userland/webhooks/checkout
```

In Stripe's webhook settings, add this address as an endpoint and choose the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`. Stripe then shows the endpoint's signing secret (`whsec_...`): save it as `CHECKOUT_WEBHOOK_SECRET` and publish again, as above.

Stripe's test mode and live mode each have their own endpoints and signing secrets, and the app checks one signing secret at a time. Try the shop out with a test-mode endpoint and your test secret key. When it starts taking real payments:

1. Add the same address as an endpoint in live mode, with the same three events.
2. Save the live endpoint's signing secret as `CHECKOUT_WEBHOOK_SECRET`, replacing the test one, and save your live secret key as `CHECKOUT_SECRET_KEY`.
3. Disable or delete the test-mode endpoint in Stripe. Userland turns its messages away once the test signing secret is replaced, and Stripe would keep retrying them and email you that the endpoint is failing.

The webhook is `"provider": "stripe"`, so Userland checks every request before the app sees it:

- The `Stripe-Signature` header must be signed with `CHECKOUT_WEBHOOK_SECRET` and be less than 5 minutes old. Missing or wrong signatures are rejected with a 400 or 401 and never reach the app.
- The header itself is never passed to the app or stored.
- An event Stripe sends again within 10 minutes of delivering it is answered once and not passed on. Stripe can still send an event again later (it retries until it gets an answer, and you can resend events from its dashboard), so the job remembers each event that paid an order in `handled-events` and ignores it the next time. Stripe retries for up to 3 days and keeps events for 30, so the hourly job forgets events after 30 days; an older event sent again finds its order paid already and takes no stock off.

No relay is needed. Before Userland could check Stripe's signature, this example needed a small service that checked Stripe's events, re-signed them and passed them on. The job now reads Stripe's own events, not the relay's, so if your copy still uses a relay, point Stripe at the address above instead and save Stripe's signing secret as `CHECKOUT_WEBHOOK_SECRET`.

The job acts on an event only when its Checkout Session's `id` is the order's `checkout_session_id`, and its `amount_total` (in cents) and `currency` match the order:

- A `checkout.session.completed` or `checkout.session.async_payment_succeeded` event whose session has `payment_status: "paid"` marks the order paid. A card payment is paid when the checkout completes.
- A `checkout.session.completed` event whose session has `payment_status: "unpaid"` is a bank payment (or another payment method that takes days). The order becomes `payment_processing`, which the hourly job doesn't cancel, until Stripe says whether the payment went through: `checkout.session.async_payment_succeeded` marks it paid and `checkout.session.async_payment_failed` cancels it.

A paid event looks like this:

```json
{
  "id": "evt_...",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "<checkout-session-id>",
      "object": "checkout.session",
      "payment_status": "paid",
      "amount_total": 2400,
      "currency": "usd"
    }
  }
}
```

Every other event is logged and ignored, such as an expired checkout. An amount or currency that doesn't match the order is ignored with a warning. A payment that arrives after the hourly job cancelled the order is left alone with a `payment received for cancelled order` warning, so you can refund it or restore the order yourself. Find these with `userland apps events <app-id> --severity warn`.

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

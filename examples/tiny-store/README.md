# Tiny Store

Small storefront with products, orders, checkout secrets, jobs, and webhooks.

## Capabilities

- Server runtime routes.
- App-user auth with `admin` and `customer` roles.
- Product and order data collections.
- Product image file uploads.
- Required checkout secrets.
- Manual and scheduled jobs.
- Generic HMAC webhook delivery into a job.

## Required secrets

Set these before exercising checkout routes:

```sh
USERLAND_API_KEY=... npm run userland -- apps secrets set <app-id> CHECKOUT_SECRET_KEY --value <value>
USERLAND_API_KEY=... npm run userland -- apps secrets set <app-id> CHECKOUT_WEBHOOK_SECRET --value <value>
```

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/tiny-store
```


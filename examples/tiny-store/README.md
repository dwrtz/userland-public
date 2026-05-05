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

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting

Capability docs:

- Secrets: https://docs.userland.fun/guides/secrets
- Jobs: https://docs.userland.fun/guides/jobs
- Webhooks: https://docs.userland.fun/guides/webhooks

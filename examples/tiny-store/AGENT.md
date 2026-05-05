# Agent notes

Goal: adapt a commerce-like app with data, files, secrets, jobs, and webhooks.

Inputs:

- Product model.
- Order lifecycle.
- Checkout provider requirements.
- Webhook payload shape.

Outputs:

- Manifest resources for products, orders, images, secrets, jobs, and webhooks.
- Storefront UI under `public/`.
- Server routes and job handler in `server/index.js`.

Steps:

1. Rename app metadata and tags.
2. Adjust product and order fields before publishing.
3. Replace mock checkout behavior with provider-specific server code.
4. Keep provider keys in `ctx.secrets`, never in frontend code.
5. Confirm job and webhook names match between manifest and server runtime.
6. Validate with `npm run validate:manifests`.

Safety:

- Do not expose checkout secrets.
- Do not trust client-submitted totals without server verification.
- Do not mark orders paid from public routes.
- Keep webhook handling idempotent.

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

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


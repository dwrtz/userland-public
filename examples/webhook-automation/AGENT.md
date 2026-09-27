# Agent notes

Goal: adapt a webhook-to-job automation pattern.

Plan: `required_plan` is `starter`. `paid_features` is `["webhooks.enabled", "webhooks.provider.generic_hmac", "webhooks.declared.max"]`: Free allows no webhooks. The one secret and one manual job fit Free limits.

Inputs:

- Webhook provider payload shape.
- Secret name.
- Job behavior.

Outputs:

- Manifest with `webhooks`, `jobs`, `secrets`, and a data collection.
- Server job handler.
- Operator instructions for setting the webhook secret.

Steps:

1. Rename the webhook and job together. `resources.webhooks.<name>.job` must equal a key in `resources.jobs` and the `event.name` your `job(event, ctx)` handler checks.
2. Keep `resources.webhooks.<name>.secret` listed in `resources.secrets.required`.
3. Senders sign with `X-Userland-Timestamp` (Unix seconds, 5-minute tolerance) and `X-Userland-Signature` (hex HMAC-SHA256 of timestamp + raw body, keyed with the webhook secret); the README has a signed curl example.
4. Read the body from `event.payload.payload`. Webhook-delivered jobs receive `event.payload = { webhook_delivery_id, name, headers, payload }`, and signature headers are redacted.
5. Make processing idempotent with the `by_external_id` unique index: create the row first and treat a `unique_conflict` error as "already processed". Do not list-then-create (two deliveries processed at once both pass the check and the second throws), and do not fall back to `webhook_delivery_id` or `job_id`: both are new for every incoming request, so a retry or a replayed signed request would be recorded again. Deliveries without a string `external_id` are skipped with a warning. Put side effects after the create so each event is acted on at most once.
6. Store only the payload fields you need (`storedFields`), never the whole body. Do not add public routes that list events; the collection is `server_only` and events can carry customer or order ids. Owners read processed events with `userland apps events <app-id> --type runtime.log.info`; if you need a page, put it behind app sign-in with an owner role.
7. Validate: `npm run validate:manifests -- webhook-automation` and `npx vitest run examples/webhook-automation`.
8. The first publish creates the app, but its release stays `pending_secrets` and is not live. Setting the secret does not activate it. Set it with `printf '%s' "$AUTOMATION_WEBHOOK_SECRET" | userland apps secrets set <app-id> AUTOMATION_WEBHOOK_SECRET`, then publish again into the same app with `userland apps publish examples/webhook-automation --app <app-id>` (without `--app` the CLI creates a second app).

Safety:

- Do not verify webhook signatures in frontend code; Userland verifies them before delivery.
- Do not log raw secrets or sensitive webhook payloads.
- Do not return stored payloads or event ids from public routes.

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

- Secrets: https://docs.userland.fun/guides/secrets
- Jobs: https://docs.userland.fun/guides/jobs
- Webhooks: https://docs.userland.fun/guides/webhooks

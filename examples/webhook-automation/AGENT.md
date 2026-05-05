# Agent notes

Goal: adapt a webhook-to-job automation pattern.

Inputs:

- Webhook provider payload shape.
- Secret name.
- Job behavior.

Outputs:

- Manifest with `webhooks`, `jobs`, `secrets`, and data collection.
- Server job handler.
- Operator instructions for setting the webhook secret.

Steps:

1. Rename the webhook and job together.
2. Keep the manifest `webhooks.<name>.job` value equal to the runtime job name.
3. Store only non-sensitive payload details.
4. Validate with `npm run validate:manifests`.
5. Test with `npm test`.

Safety:

- Do not verify webhook signatures in frontend code.
- Do not log raw secrets or sensitive webhook payloads.

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting

Capability docs:

- Jobs: https://docs.userland.fun/guides/jobs
- Webhooks: https://docs.userland.fun/guides/webhooks

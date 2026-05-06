# Webhook Automation

Generic HMAC webhook pattern that delivers signed webhook payloads to a manual Userland job.

## Required secret

```sh
userland apps secrets set <app-id> AUTOMATION_WEBHOOK_SECRET --value <value>
```

## Publish

```sh
userland apps publish examples/webhook-automation
```

## Mock webhook flow

Configure the external provider to sign payloads with `AUTOMATION_WEBHOOK_SECRET` and deliver to the Userland webhook URL for the `automation` webhook. The platform verifies the HMAC signature and delivers the payload to the `process-automation-event` job.

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

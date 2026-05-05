# Webhook Automation

Generic HMAC webhook pattern that delivers signed webhook payloads to a manual Userland job.

## Required secret

```sh
USERLAND_API_KEY=... npm run userland -- apps secrets set <app-id> AUTOMATION_WEBHOOK_SECRET --value <value>
```

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/webhook-automation
```

## Mock webhook flow

Configure the external provider to sign payloads with `AUTOMATION_WEBHOOK_SECRET` and deliver to the Userland webhook URL for the `automation` webhook. The platform verifies the HMAC signature and delivers the payload to the `process-automation-event` job.


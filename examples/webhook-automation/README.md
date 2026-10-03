# Webhook Automation

Receive signed webhooks from another service and process each one in a background job.

## What it shows

- A webhook that Userland verifies before the app sees it.
- A background job that records each event once, even when the sender retries or the same request is replayed.
- An `automation-events` data collection that only server code can read or write. It keeps each event's `external_id` and `type`, not the whole body.
- No public routes: processed events show up in the app's activity log, which only members of your Userland account can read.

## Plan

**Plan needed: Starter.** This example is intentionally paid: the Free plan does not include webhooks.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/webhook-automation
```

The first publish creates the app and prints its app id. That release is not live yet: its activation status is `pending_secrets` because the secret is missing. Setting a secret does not activate a stored release, so set it and then publish again into the same app:

```sh
printf '%s' "$AUTOMATION_WEBHOOK_SECRET" | userland apps secrets set <app-id> AUTOMATION_WEBHOOK_SECRET
userland apps publish examples/webhook-automation --app <app-id>
```

You can add the secret in the console instead: open `https://console.userland.fun/apps/<app-id>/settings?add-key=AUTOMATION_WEBHOOK_SECRET`, paste the secret, and save it, then publish again with `--app` as above. A coding agent setting up the app for you sends you this link rather than asking you to paste the secret into your chat.

Always pass `--app <app-id>` when publishing again. Without it, the CLI creates a second app.

## Connect the sender

Point the sending service at:

```text
https://<app-id>.apps.userland.fun/_userland/webhooks/automation
```

Userland checks every request before the app sees it, using the `generic_hmac` scheme:

- `X-Userland-Timestamp`: the current Unix time in seconds. Requests more than 5 minutes off are rejected.
- `X-Userland-Signature`: the hex HMAC-SHA256 of the timestamp followed directly by the raw request body, keyed with ``AUTOMATION_WEBHOOK_SECRET``. A `sha256=` prefix is optional.

Missing or wrong headers are rejected with a 400 or 401 and never reach the app.

Every event must include an `external_id`: the sender's own id for the event (letters, digits, and `. _ : -`, up to 200 characters), the same on every retry. It is how repeats are recognized. Events without one are skipped with an `automation event skipped` warning, because Userland gives each incoming request a new delivery id and a retry would otherwise look like a new event. Userland does not remember signed requests, so a captured request can be sent again within the 5-minute window; the `external_id` check makes that harmless too.

Send a signed test event from a terminal:

```sh
body='{"external_id":"test-1","type":"test"}'
ts=$(date +%s)
sig=$(printf '%s%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$AUTOMATION_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST https://<app-id>.apps.userland.fun/_userland/webhooks/automation \
  -H 'content-type: application/json' \
  -H "X-Userland-Timestamp: $ts" \
  -H "X-Userland-Signature: sha256=$sig" \
  --data "$body"
```

## Try it

After sending the test event, check that it was processed:

```sh
userland apps events <app-id> --type runtime.log.info --limit 10
```

Sending the same body again logs `automation event already processed` instead.

## Troubleshoot or undo

```sh
userland apps events <app-id> --severity error --limit 25
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
```

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

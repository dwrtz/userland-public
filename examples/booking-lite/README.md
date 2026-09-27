# Booking Lite

Let people book time slots without two people getting the same slot.

## What it shows

- Server routes to add sample slots, list open slots, and book one.
- `slots` and `bookings` data collections that only server code can write.
- A data transaction that checks the slot is still open and books it in one step, so a second booking for the same slot is refused.
- Public slot lists never show who booked.

## Plan

**Plan needed: Free.** Nothing in this example needs a paid plan.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/booking-lite
```

## Try it

Add two sample slots (tomorrow and the day after):

```sh
curl -X POST https://<app-id>.apps.userland.fun/api/seed
```

List open slots:

```sh
curl https://<app-id>.apps.userland.fun/api/slots
```

Book a slot:

```sh
curl -X POST https://<app-id>.apps.userland.fun/api/bookings \
  -H 'content-type: application/json' \
  --data '{"slot_id":"<slot-id>","name":"Ada","email":"ada@example.test"}'
```

The first booking returns `201`. A second booking for the same slot returns `409`.

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

- Data: https://docs.userland.fun/guides/data

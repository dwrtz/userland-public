# Booking Lite

Let people book time slots without two people getting the same slot.

## What it shows

- A page that lists open times and books one.
- Slots you list in `server/schedule.js`. The app stores any new ones the next time someone opens the slot list, skips times that have passed, and deletes past slots nobody booked.
- `slots` and `bookings` data collections that only server code can write.
- A unique index on the booking's `slot_id`, so a slot can only ever have one booking, even when two people book it at the same moment. The second person gets `409`.
- Public slot lists never show who booked.

Because anyone can book, the app also:

- checks names (up to 120 characters) and email addresses;
- allows 2 bookings per email address per day, and 20 bookings an hour across the whole app (`429` after that). Apps can't see visitors' IP addresses, so there is no per-person limit beyond the email;
- drops posts from simple bots that fill in a hidden form field;
- only takes bookings from its own page, not from other sites.

There is no owner view or cancel button: bookings are stored where only server code can read them. For an inbox where the owner reviews and cancels bookings, start from the Booking App example instead.

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

Open `https://<app-id>.apps.userland.fun/` and book a time. The sample schedule offers an intro call tomorrow and a planning session the day after, at 16:00 UTC.

Or list open slots with curl:

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

## Use your own slots

Edit `scheduledSlots` in `server/schedule.js` to return your times, then publish again with `--app <app-id>`:

```js
export function scheduledSlots() {
  return [
    { title: "Intro call", starts_at: "2026-11-02T16:00:00Z" },
    { title: "Intro call", starts_at: "2026-11-03T16:00:00Z" }
  ];
}
```

Delete `tests/sample-schedule.test.ts`, which only checks the sample times. Sample slots that were already stored stay until they pass (booked ones stay after that).

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

# Agent notes

Goal: adapt a booking flow that avoids double-claiming a slot.

Plan: `required_plan` is `free`; `paid_features` is `[]`. Two collections (the Free maximum) with two indexes each (also the Free maximum) and no auth, secrets, jobs, or webhooks. A third collection or index needs Starter (`data.collections.max`, `data.indexes_per_collection.max`).

Inputs:

- The slots to offer.
- Booking form fields.
- Confirmation behavior.

Outputs:

- Manifest with `slots` and `bookings` collections.
- `server/schedule.js` listing the offered slots.
- Server routes for listing slots and creating bookings, and a page in `public/` that uses them.

Steps:

1. The unique `by_slot` index on `bookings.slot_id` is what prevents double booking. `ctx.data.transaction` only groups the calls: in deployed apps it neither serializes concurrent requests nor rolls back a write when a later step throws. Two people booking at once both see the slot as open; the second `bookings.create` throws `unique_conflict`, which `createBooking` catches and turns into `409 slot_unavailable`. Never catch it generically or let it escape (uncaught, it answers `400 unique_conflict`).
2. Write the booking first, then mark the slot booked. If the slot update fails, delete the booking just created (`booking undone` in the log) so the slot stays bookable. If a request stopped between the two writes, the next attempt on that slot gets `409` and `repairSlot` marks the slot booked.
3. To free a slot (a cancel route, say), delete its booking row; deleting releases the unique value. Do not add a `cancelled` status that keeps the row, or the slot can never be booked again.
4. Slots come from `scheduledSlots(now)` in `server/schedule.js`. `GET /api/slots` stores missing future ones (the unique `by_time` index on `starts_at` + `title` keeps simultaneous requests from adding one twice), deletes up to 10 past unbooked slots, and returns every open future slot, paging through all rows. There is no route that creates slots from request data.
5. Keep the limits while booking is anonymous: `validateBooking` (name 1-120 characters, email pattern, 254 max), the hidden `website` honeypot, `LIMITS.bookingsPerEmailPerDay` (via the `by_email` index), `LIMITS.bookingsPerHour` app-wide, rejecting slots that have started, and the same-origin check on POST. Apps do not get visitor IPs. These checks read before writing, so bursts can go slightly over; the unique index is the only hard guarantee.
6. Filter and sort only on indexed fields; `by_status` covers `status` and `starts_at`, `by_email` covers `email`.
7. Validate: `npm run validate:manifests -- booking-lite` and `npx vitest run examples/booking-lite`.

Use your own slots (removes the sample data):

1. Replace the body of `scheduledSlots` in `server/schedule.js` with a list of `{ title, starts_at }` objects (ISO 8601, UTC), or code that builds them from opening hours. Delete `sampleTime`.
2. Delete `tests/sample-schedule.test.ts`. `tests/booking-lite.test.ts` creates its own slots and works with any schedule.
3. Run `npx vitest run examples/booking-lite`, then publish with `--app <app-id>`.

Safety:

- Do not trust client-submitted availability; `createBooking` reads the slot on the server.
- Do not remove the unique index on `bookings.slot_id`; it is the double-booking guard.
- Do not expose names, emails, or `booked_by` from public list routes, and do not log them.
- Do not add a public route that creates slots from request data; add sign-in with an owner role first (see the Booking App example).

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

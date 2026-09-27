# Agent notes

Goal: adapt a booking flow that avoids double-claiming a slot.

Plan: `required_plan` is `free`; `paid_features` is `[]`. Two collections (the Free maximum) with one index each and no auth, secrets, jobs, or webhooks. A third collection needs Starter (`data.collections.max`).

Inputs:

- Slot fields and availability states.
- Booking form fields.
- Confirmation or cancellation behavior.

Outputs:

- Manifest with `slots` and `bookings` collections.
- Server routes for listing slots and creating bookings.
- Transactional booking logic.

Steps:

1. Keep slot claim and booking creation inside `ctx.data.transaction(async (tx) => ...)`, using `tx.collection(...)`.
2. Check slot availability inside the transaction.
3. Update the slot after creating the booking.
4. Return `409` when a slot is no longer available.
5. Filter and sort only on indexed fields; `by_status` covers `status` and `starts_at`.
6. Protect or remove `/api/seed` before real use; it is open so the demo can add sample slots.
7. Validate: `npm run validate:manifests -- booking-lite` and `npx vitest run examples/booking-lite`.

Safety:

- Do not trust client-submitted availability.
- Do not create a booking outside the transaction.
- Do not expose names, emails, or `booked_by` from public list routes.

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

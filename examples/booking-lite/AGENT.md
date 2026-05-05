# Agent notes

Goal: adapt a booking flow that avoids double-claiming a slot.

Inputs:

- Slot fields and availability states.
- Booking form fields.
- Confirmation or cancellation behavior.

Outputs:

- Manifest with `slots` and `bookings` collections.
- Server routes for listing slots and creating bookings.
- Transactional booking logic.

Steps:

1. Keep slot claim and booking creation inside `ctx.data.transaction`.
2. Check slot availability inside the transaction.
3. Update the slot after creating the booking.
4. Return `409` when a slot is no longer available.
5. Validate with `npm run validate:manifests`.
6. Test with `npm test`.

Safety:

- Do not trust client-submitted availability.
- Do not create a booking outside the transaction.
- Do not expose private booking details from public list routes.


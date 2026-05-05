# Booking Lite

Slot booking app that claims availability inside a Userland data transaction.

## Capabilities

- Server runtime routes.
- Data collections for `slots` and `bookings`.
- `ctx.data.transaction` around slot claim and booking creation.

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/booking-lite
```

## Verify

Seed initial slots:

```sh
curl -X POST <origin>/api/seed
```

List available slots:

```sh
curl <origin>/api/slots
```

Book a slot:

```sh
curl -X POST <origin>/api/bookings \
  -H 'content-type: application/json' \
  --data '{"slot_id":"<slot-id>","name":"Ada","email":"ada@example.test"}'
```

The first booking returns `201`. A second booking for the same slot returns `409`.


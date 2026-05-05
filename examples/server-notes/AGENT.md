# Agent notes

Goal: adapt a server-backed notes app.

Inputs:

- Fields for the durable note-like object.
- Route names for create and list operations.

Outputs:

- Manifest with a data collection.
- Server routes that use `ctx.data`.
- Runtime logs for write operations.

Steps:

1. Update the `notes` collection fields.
2. Keep writes on server routes.
3. Log successful writes with non-sensitive identifiers.
4. Validate with `npm run validate:manifests`.
5. Test with `npm test`.

Safety:

- Do not put `USERLAND_API_KEY` in static files.
- Do not log sensitive note body content.


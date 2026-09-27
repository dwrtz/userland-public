# Agent notes

Goal: adapt a server-backed notes app.

Plan: `required_plan` is `free`; `paid_features` is `[]`. One collection with one index and no auth, files, secrets, jobs, or webhooks.

Inputs:

- Fields for the durable note-like object.
- Route names for create and list operations.

Outputs:

- Manifest with a data collection.
- Server routes that use `ctx.data`.
- Runtime logs for write operations.

Steps:

1. Update the `notes` collection fields. `id`, `created_at`, `updated_at`, `deleted_at`, and `data` are reserved field names.
2. Only filter or sort on indexed, declared fields. `created_at` and `updated_at` cannot be used in `order_by`; with no `order_by`, rows come back most recently updated first.
3. Keep writes on server routes and validate input before `create`: `readJson` answers `415`/`413`/`400` for non-JSON, oversized, or non-object bodies, and titles and bodies have length limits.
4. Keep the abuse limits in `LIMITS` while writes stay anonymous: an app-wide hourly cap, a cap on stored notes, deletion of notes older than `keepDays` (a few per request), a hidden `website` honeypot field, and the same-origin check on POST. Apps do not get the visitor's IP address, so there is no per-person limit; the checks read before they write, so a burst can go slightly over. Size the caps to stay well under the plan's data row limit.
5. Keep the list paginated with `cursor`; do not raise `limit` to hide pagination.
6. Log successful writes with identifiers only.
7. Add `auth` before storing anything private, or to let an owner delete notes: the example accepts writes from any visitor and has no moderation.
8. Validate: `npm run validate:manifests -- server-notes` and `npx vitest run examples/server-notes`.

Safety:

- Do not put `USERLAND_API_KEY` in static files.
- Do not log note body content.

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

- Server app quickstart: https://docs.userland.fun/quickstarts/server-app
- Data: https://docs.userland.fun/guides/data

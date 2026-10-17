# Native notes reference app

This app runs as a plain Cloudflare Worker with a dedicated D1 database, private R2 bucket and generated `SESSION_SECRET` binding. It imports no Userland runtime or authentication SDK. Its users and sessions are app data, separate from the Userland account that owns the deployment.

`wrangler.jsonc` declares the logical D1 database `notes` on binding `DB` and the `migrations` directory. The provisioner assigns the exact provider database separately for preview and production. `apply.json` supplies the top-level `secret_requirements` field for `apps.apply`; the generated value must never be pasted into source, CLI output or an agent conversation. Repeated deployments reuse the environment's existing database and secret revision, preserving sessions and notes.

The prebuilt source package contains `worker.js`, `wrangler.jsonc`, the migrations and `public/` files. No compilation or package install is needed.

## Private attachments

`FILES` is a native R2 binding to the logical private bucket `attachments`. Each environment receives its own bucket. The app exposes authenticated upload, list, streaming download/HEAD and delete routes under `/api/files`. The caller supplies a filename, never a bucket name or object key. The Worker creates an immutable key from the authenticated user and a random attachment ID, and D1 records ownership, byte count and completion state. File IDs from another user, app or environment return 404 before an object read or delete.

Uploads require a known content length from 1 byte to 1 MiB. A `FixedLengthStream` feeds R2 without buffering the complete file and rejects a truncated or oversized stream. A 30-second deadline aborts stalled uploads while retaining their unresolved metadata. Download responses stream the native R2 body, force attachment delivery and use private/no-store caching. Notes, file identity and sessions survive code replacements that retain the same owned bindings.

A failed or ambiguous upload is never made readable. Its metadata remains `failed` with `upload_unconfirmed` or `upload_timeout`, so a lost response cannot be mistaken for an absent object. Cleanup of a failed upload requires a positive lookup of its exact owned key; an absent lookup keeps its record unresolved. Deletion of a completed upload can be retried against the same immutable key. The UI displays unresolved records and their errors.

The list response includes app-local stored-byte and pending-file counts. These are reference-app metadata, not trusted platform billing measurements or an account-wide dollar cap. N11 must reconcile provider storage and request usage through the ownership inventory.

## Authentication boundary

The app hashes passwords with PBKDF2-SHA-256 and a random per-user salt. Session tokens contain 32 random bytes; D1 stores only their HMAC under the environment's `SESSION_SECRET`. The cookie is exactly `__Host-notes_session`, with `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`, without a Domain attribute. A logout deletes the server session and expires the cookie. WebSockets require the same-origin handshake and check the server session again before each message.

Every state-changing request requires an exact `Origin` match to the current app URL. Static UI code uses DOM text nodes for notes, so a saved note is not interpreted as HTML. The gateway enforces the shared-host cookie and frame policy as an additional boundary. Do not loosen app Origin checks because the gateway is present, and do not replace the host-only cookie with a parent-domain cookie.

This is an internal reference flow, not a complete public identity product. It deliberately has no email delivery, password recovery, social sign-in, user administration or abuse-limiting service. Add those deliberately if an app needs them. It does not place app authentication behind Userland management APIs.

## Build, deploy and continue

This is the selected native reference. Read https://docs.userland.fun/native-guide.md and discover current capabilities before applying it. Hosting is currently enabled only for bounded internal Accounts.

```sh
userland apps apply ./examples/native-notes --account "$ACCOUNT_ID" --name "Native notes" \
  --environment preview --mode preview --audience private \
  --secret-requirements-json '[{"name":"SESSION_SECRET","ensure":"generated","bytes":32}]' \
  --idempotency-key notes-first-preview --json
```

Poll the returned operation, test sign-in, notes and attachments, and preserve its app, source and deployment identities. Use exact app revisions for updates. Do not publish a preview result as proof of different production bindings.

## Portability

The Worker imports no Userland package. To deploy to your own Cloudflare Account, keep the Worker, assets and migration files unchanged; map the logical D1 database and R2 bucket to resources you own, set the Account/Worker names in Wrangler configuration, apply the migrations, and supply a fresh SESSION_SECRET through Cloudflare's secret mechanism. Do not put the value in source. This is source portability, not an automatically managed bring-your-own-Account product.

## References

- https://docs.userland.fun/llms.txt
- https://docs.userland.fun/native-guide.md
- https://docs.userland.fun/quickstarts/from-example/
- https://docs.userland.fun/reference/api/
- https://docs.userland.fun/reference/cli/
- https://docs.userland.fun/guides/troubleshooting/

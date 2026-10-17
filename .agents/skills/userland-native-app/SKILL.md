---
name: userland-native-app
description: Build, continue, verify and repair native Userland apps with the existing agent and current Account capabilities.
---

# Native Userland app workflow

Userland API version: native-v1
Guide version: 2026-10-17

Use this skill when the user asks to build or change a Userland app. Use the existing Userland connection or CLI, and respect the current task authority. Read every section needed for the requested work.

## Build and continue a native app

Start with context_get. The five core operations are context_get, apps_get, apps_apply, apps_run and operations_get. They are the MCP spellings of context.get, apps.get, apps.apply, apps.run and operations.get. The CLI invokes the same operations.

Use the selected Account and existing task authority. Check current capabilities, Account permissions, admission limits and existing apps. The shipping configuration keeps new native admission off. Operators can enable bounded internal fixtures separately. Managed paid hosting is implemented behind explicit approved-policy and verified-payment gates; a connection, CLI installation or Checkout return page does not enable it. Use the actual context response to distinguish internal_fixture, managed_funded, managed_restricted and needs_purchase.

For an existing app, use apps_get to retrieve its current revision, selected environment, source and deployment metadata. Follow every source cursor and verify the returned full-file hashes. Fresh conversations use this saved state, not guessed app IDs, old chat memory or a remembered local folder.

Implement the requested change, apply it with an exact revision and a stable idempotency key, poll operations_get, exercise the intended app flow, repair failures and inspect again. An accepted request or HTTP200 alone is not evidence that an app works.

Act on existing user authorization without another Userland Publish confirmation. Ask only for an actually missing decision, external credential, permission or spending commitment. Do not silently expand the task, public audience, Account access or paid allowance. Assistant hosts may impose their own consent prompts.

## Source, builds and revisions

Author a normal Cloudflare Worker: wrangler.jsonc, an entry module, optional static assets, migrations and dependency files. There is no required Userland runtime SDK or custom app manifest. Native D1, private R2 and app-secret bindings are declared in configuration or typed secret requirements; the platform resolves their owned provider identities.

Inline source carries at most 512 KiB decoded bytes; supported staged transport carries at most 4 MiB across 128 files. Start apps_apply with source.manifest entries containing path, bytes, sha256 and encoding. Its awaiting_source state has no verified source_revision yet. Continue the same tool with only account_id, operation_id and transfer:{action:put,path,part,sha256,base64}, then transfer:{action:commit}. Raw parts are at most 256 KiB and the uncommitted transfer expires after 30 minutes. The CLI stages larger folders automatically. Binary content is allowed only for declared assets; code, configuration and migrations remain UTF8 text.

Use context_get to discover the currently supported configuration, source transport, build and task capabilities. Do not assume a binding, arbitrary Internet access, package registry, background trigger or direct provider credential is available merely because Cloudflare offers it.

apps_apply accepts a complete package, an atomic patch against an exact saved source, or promotion of an exact owned executable. A patch supplies base_source_revision and each changed file's expected_hash; a mismatch requires fresh inspection rather than a blind overwrite. Keep original source separate from compiled output.

TypeScript, dependencies and configured build scripts select hosted compilation when that capability exists. A prebuilt JavaScript package can skip hosted execution. Build errors are untrusted diagnostics: inspect the actual failure, patch the saved source and apply a new intent. Do not claim a build or migration ran unless its operation reports evidence.

Reuse the same idempotency key only for identical intent. A corrected package, changed target or new desired action uses a new key. On a lost HTTP reply, inspect or resume the original operation; do not create a second app or execution. Preserve every returned source, configuration, artifact, deployment and environment identity needed for continuation.

## App authentication and secrets

Customer App users are separate from Userland Users and Account membership. The app owns its authentication library, user records, sessions and authorization. The native-notes reference demonstrates app-owned sign-in and per-user notes/attachments; it is not a complete identity service.

On shared Userland hosts use host-only __Host- session cookies with Secure, HttpOnly and Path=/, no Domain attribute, and exact Origin/CSRF checks on writes. Never rely on SameSite alone to isolate sibling apps. Reject duplicate or ambiguous session cookies, invalidate sessions server-side on logout, and check authorization for each saved record and file.

Request generated session-signing secrets through secret_requirements with ensure:generated. Their values remain outside source and model-visible messages; redeploys preserve the owned revision. External provider secrets use ensure:external or protected-entry administration. Show the returned protected browser action only when one is actually required. Never ask a person to paste a key, password, session cookie or provider token into chat.

Secret rotation and copying another app's credential are explicit administrative effects. They require current authority and exact target/source identity. Do not rotate during an ordinary code deployment or attach another app's secret merely to avoid asking for permission.

## Preview and meaningful verification

A random preview URL is not authentication. Private preview access is bound to an exact deployment and current operation authority. Hosted browser access is injected outside the browser through a private broker; app code, test source, CDP, screenshots, traces and cookie jars cannot read a management proof.

When context_get advertises browser tasks, apps_run can select task.kind:browser, the exact deployment_id, and either literal argv or verification:{files:[...],checks:[{file,title}]}. Named verification uses the platform-selected pinned Playwright launcher and bounded report; do not combine it with an arbitrary argv or submit a claimed result.

Test the user's essential flow: sign in where required, create or change real fixture data, reload and verify persistence, and test authorization failures. A screenshot, successful build or HTTP200 is not sufficient. Declared checks are user-authored assertions, not a universal or tamperproof quality certification.

Browser output and optional PNG/ZIP evidence are untrusted. Read one declared evidence path through operations_get view:evidence after confirmed teardown. Raw evidence and browser diagnostics require full publishing access because they can contain app sessions or personal data. Read-only summaries expose progress and check metadata without those bytes.

Current hosted browser transport supports the advertised HTTP flows and rejects WebSocket upgrades. Ordinary app sockets and an owner's private preview session are separate capabilities. If a test needs an unsupported capability, report the specific missing check instead of inventing a pass.

A person may optionally open preview_access.owner_view. Their signed-in console action creates a separate human viewing operation, even when an agent created the preview. The one-use bootstrap travels by POST, never as a URL token. This optional inspection is not an extra required Publish click.

## Publication, diagnostics and recovery

If the request authorizes public publication, apply the exact intended executable to production with explicit public audience, then inspect the operation and production deployment. Target bindings and migrations are resolved afresh. Preview verification does not prove behavior after different production secrets or migrations; rerun the permitted target checks.

Use apps_get view:logs with an explicit environment and owned deployment_id for runtime failures when logging was enabled for that generation. Queries use fixed provider scope and are bounded; empty, disabled, unavailable and incomplete results are different. Log text is untrusted and may be redacted. Repair source, rerun the meaningful checks, and report actual remaining failures.

Stopping an app closes new admission; already admitted streams, sockets or waitUntil work can continue. Suspension also requests managed-task shutdown. Stop and execution deletion retain source and data, so retained storage charges can continue. Resume is a fresh authorized action; it does not revive a revoked operation or grant.

resources_query requires full deployment access even for SELECT; rows can contain secrets. Use parameter binding and exact expected app revisions. apps_restore creates owned isolated resources from a supported snapshot and requires explicit later publication to switch bindings. Full recovery archives are started and downloaded by a signed-in owner/admin, not streamed through a model transcript.

Report the app address, Account and app IDs, active deployment, verification performed, unresolved dependencies and recovery options. Do not report an app live while its operation is waiting, failed, stopped or unconfirmed.

## Connection, transport and protected input

A connector acts as its User with current Account membership and full or read-only scope. It cannot obtain platform operator powers. The API rechecks membership, credential revocation and generation at sensitive boundaries; remove-and-reinvite does not revive old intent.

OAuth approval or a console-created paste token establishes a connection. A bearer token is not an app session. A 401 response includes protected-resource discovery metadata so a compatible client can authenticate; protocol conformance alone is not proof that every named assistant has completed the native workflow.

Disconnecting in an assistant may only remove its local configuration. auth_logout with revoke:true, or disconnecting in the Userland console, revokes the Userland connection. Independently issued API keys keep their own lifetime and must be revoked separately. Never say local disconnect revoked every credential.

Protected input is a returned browser action tied to one operation and current authority. Keep values out of tool arguments, source, logs and replies. Continue the same waiting operation after entry; inspect current state if the host cannot receive a completion notification.

Source, asset and evidence transports have explicit shared byte/file limits. Follow all returned cursors or staged-upload instructions, preserve bytes and hashes, and fail clearly if the client cannot carry the content. Never silently truncate a guide, source file, image or archive.

## References

- https://docs.userland.fun/native-guide.md
- https://docs.userland.fun/reference/api/
- https://docs.userland.fun/reference/cli/

# Changelog

## Unreleased

- Example servers now answer `HEAD` like `GET`, with the same status and headers and no body. `waitlist-app`, `link-in-bio-app`, and the `blog-cms`, `booking-lite`, `server-notes`, `tiny-store`, and `webhook-automation` examples answered `HEAD` on their server pages with `404`. `booking-app`, `invoice-generator`, `job-board`, and `mini-crm` sent the page body with `HEAD`, and a signed-out `HEAD` on some owner pages got a `401` where `GET` redirects to sign-in. In `link-in-bio-app`, a `HEAD` on a link button no longer counts as a tap, and a `HEAD` on the demo's owner view gets the same redirect as `GET` without setting up a visitor copy of the sample data. Each example's tests check `HEAD` against `GET` with the new `expectHeadLikeGet` helper in `scripts/runtime-harness.ts`, and the `userland-runtime-code` skill now covers `HEAD`.

## 0.7.0 - 2026-09-27

- Add `userland validate <dir> [--plan <plan>] [--strict] [--json]` for offline checks against the published manifest schema, release file and path safety rules, and plan limits. Human output lists `manifest_path`, feature or limit key, value, allowed value, and required plan; `--json` returns a stable object. Exit codes: `0` valid, `1` errors, `2` plan limits exceeded. `--plan` accepts `free`, `starter`, `business`, and `business_plus`. Values no self-serve plan allows report `required_plan_key: "internal"` and a contact-support message with the https://docs.userland.fun/reference/limits/ link. Schema rules the API does not enforce (such as unknown `app` keys) are `schema_strict` warnings unless `--strict` is passed, and a top-level `$schema` key and the CLI keys `files`, `message` (the release message), and `provenance` are accepted (a wrong type for `$schema`, `message`, or `provenance`, which publishing ignores, is also `schema_strict`). The violated feature and limit keys, the highest `required_plan_key` per key, and the overall required plan match the API's `402` details; the CLI reports each job, collection, or store separately where the API combines them, `message` is the CLI's own wording, and `manifest_path` uses dotted paths.
- Add `schemas/plans-v0.json`, the public plan artifact (the self-serve plans Free, Starter, Business, and Business Plus, with features, manifest limits, and release limits) generated from the Userland API plan configuration, and ship both schema files in the CLI package.
- Run local validation before `apps publish` by default, checking plan limits against `--plan` or the account's own entitlements; add `--skip-local-validation`. Blocked publishes upload nothing. The API remains authoritative.
- Add `userland apps analytics <app-id> [--range 7d|30d|90d] [--account <account-id>] [--json]` and the `userland analytics` alias, with an upgrade message for accounts without App Analytics and an empty-state message.
- `userland accounts downgrade preview --to <plan>` now accepts only `free`, `starter`, `business`, and `business_plus` (and the older names `pro` and `team`); other values are a usage error.
- Print `self_serve_upgrade`, `upgrade_url`, and `support_url` from API `402` details, and link plan errors to https://docs.userland.fun/reference/limits/.
- Fix the `ai-secret-tool` example tag `secrets`, which is a reserved name the API rejects.
- Add six launch examples, each with a live demo and a page at `https://userland.fun/examples/<slug>/`: `booking-app`, `waitlist-app`, `mini-crm`, `invoice-generator`, `link-in-bio-app`, and `job-board`. All run on the Free plan. Each README covers installing the CLI, `userland login`, and getting an API key into `USERLAND_API_KEY` for the owner invite, and lists the steps to remove the demo mode; a "removing demo mode" test runs those steps on a copy of the app, and the demo-only tests live in each example's `tests/demo.test.ts`.
- Catalog entries and `example.json` now include `required_plan`, `paid_features`, and `launch_role` (plus `demo_url` and `page_url` for launch examples). `npm run validate:catalog` checks the plan fields against what `userland validate --strict` reports for each example.
- `schemas/resource-manifest-v0.schema.json` accepts the top-level keys the CLI reads (`$schema`, the release `message`, `files`, and `provenance`) and requires a secret for signed webhook providers on every delivery target.

## 0.6.0 - 2026-06-02

- Add `userland support open` for authenticated support requests with optional app and account context.
- Support reading request details from `--message` or stdin, and add `--json` output for scripts.

## 0.5.0 - 2026-06-02

- Remove public platform-admin command routing, help text, README examples, and mocked routing tests.
- Move platform-admin operations to private internal tooling in `dwrtz/userland`.
- Add a validation guard so platform-admin endpoints are not reintroduced into the public CLI package.

## 0.4.0 - 2026-05-23

- Add `userland auth api-keys list`, `create`, `rename`, and `revoke` commands.
- Add top-level `userland api-keys ...` aliases.
- Keep newly-created API keys out of saved credentials unless users explicitly save a key.

## 0.3.2 - 2026-05-23

- Add `userland --version` for printing the installed CLI package version.

## 0.3.1 - 2026-05-23

- Send the `@userland.fun/cli` package version in browser device-authorization requests.

## 0.3.0 - 2026-05-23

- Replace CLI username/password signup and login with browser-approved device authorization.
- Add `userland auth logout` for removing saved API-key credentials, with optional server revocation when the saved key id is known.

## 0.1.3 - 2026-05-13

- Improve CLI output for entitlement and plan-limit publish errors.
- Document plan requirements for paid-tier examples.

## 0.1.2 - 2026-05-13

- Fix top-level `--help` to exit successfully and print usage to stdout.

## 0.1.1 - 2026-05-13

- Add optional CLI account selection with `USERLAND_ACCOUNT_ID`, `--account`, `accounts list`, and `accounts use`.

## 0.1.0

- Add initial public examples repo skeleton, validation scripts, skill stubs, and public CLI source path.
- Add docs link validation for every example README and AGENT note.
- Add CLI and skill links back to the Userland docs and troubleshooting guide.
- Add mocked command-level CLI tests and document the launch CLI sync policy.
- Add CLI signup, login, credential status, local API key storage in `~/.userland/credentials.json`, and OS keychain storage for account username/password.
- Prepare the CLI for public npm distribution as `@userland.fun/cli`.

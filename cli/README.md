# Userland CLI

This directory is the source for the public `@userland.fun/cli` npm package.

Docs:

- https://docs.userland.fun/llms.txt
- https://docs.userland.fun/reference/cli
- https://docs.userland.fun/guides/troubleshooting

Install globally:

```sh
npm install -g @userland.fun/cli
```

Then run:

```sh
userland --version
userland login
userland login --no-browser
userland signup
userland auth status
userland auth save-key --api-key <api-key>
userland auth logout
userland auth logout --revoke
userland auth api-keys list
userland auth api-keys create --name "CI deploy key"
userland auth api-keys rename <api-key-id> --name "Production deploy"
userland auth api-keys revoke <api-key-id> --yes
userland accounts list
userland accounts use <account-id>
userland accounts status --account <account-id>
userland accounts limits --account <account-id>
userland accounts downgrade preview --to free --account <account-id>
userland support open --subject "Deploy failed" --message "The latest release is throwing errors." --app <app-id>
userland validate examples/<example-slug>
userland validate examples/<example-slug> --plan free
userland validate examples/<example-slug> --json
userland apps publish examples/<example-slug>
userland apps publish examples/<example-slug> --account <account-id>
userland apps publish examples/<example-slug> --plan starter
userland apps list
USERLAND_ACCOUNT_ID=<account-id> userland apps list
userland apps status <app-id>
userland apps releases <app-id>
userland versions <app-id>
userland apps rollback <app-id> <release-id>
userland apps secrets set <app-id> <NAME> --value <value>
userland apps events <app-id>
userland apps analytics <app-id>
userland apps analytics <app-id> --range 7d --json
userland analytics <app-id>
userland apps routes list <app-id>
userland apps slugs add <app-id> <slug>
userland apps domains add <app-id> <hostname>
userland apps domains verify <app-id> <hostname>
```

From this repo, the same commands can be run from source:

```sh
npm run userland -- --version
npm run userland -- login
npm run userland -- login --no-browser
npm run userland -- signup
npm run userland -- auth status
npm run userland -- auth save-key --api-key <api-key>
npm run userland -- auth logout
npm run userland -- auth logout --revoke
npm run userland -- auth api-keys list
npm run userland -- auth api-keys create --name "CI deploy key"
npm run userland -- auth api-keys rename <api-key-id> --name "Production deploy"
npm run userland -- auth api-keys revoke <api-key-id> --yes
npm run userland -- accounts list
npm run userland -- accounts use <account-id>
npm run userland -- accounts status --account <account-id>
npm run userland -- accounts limits --account <account-id>
npm run userland -- accounts downgrade preview --to free --account <account-id>
npm run userland -- support open --subject "Deploy failed" --message "The latest release is throwing errors." --app <app-id>
npm run userland -- validate examples/<example-slug>
npm run userland -- validate examples/<example-slug> --plan free --json
npm run userland -- apps publish examples/<example-slug>
npm run userland -- apps publish examples/<example-slug> --account <account-id>
npm run userland -- apps list
npm run userland -- apps list --account <account-id>
npm run userland -- apps status <app-id>
npm run userland -- apps releases <app-id>
npm run userland -- versions <app-id>
npm run userland -- apps rollback <app-id> <release-id>
npm run userland -- apps secrets set <app-id> <NAME> --value <value>
npm run userland -- apps events <app-id>
npm run userland -- apps analytics <app-id> --range 30d
npm run userland -- apps routes list <app-id>
npm run userland -- apps slugs add <app-id> <slug>
npm run userland -- apps domains add <app-id> <hostname>
npm run userland -- apps domains verify <app-id> <hostname>
```

`login` starts a browser device-authorization flow. The CLI prints a verification URL and user code, opens the browser when possible, waits for approval, then saves the returned API key to `~/.userland/credentials.json` with `0600` permissions. `signup` is an alias for the same flow; if the email is new, account creation happens in the browser after email proof.

The CLI does not store platform passwords. App commands prefer `USERLAND_API_KEY` when it is set, then fall back to the saved API key. `auth save-key` remains available for CI, support, and manually copied API keys.

API key lifecycle commands use the same authenticated management endpoints as the browser console:

```sh
userland auth api-keys list
userland auth api-keys create --name "CI deploy key"
userland auth api-keys rename key_... --name "Production deploy"
userland auth api-keys revoke key_... --yes
```

`auth api-keys list` prints metadata only. `auth api-keys create` prints the raw key exactly once and does not write it to `~/.userland/credentials.json`. `auth api-keys revoke` prompts in interactive terminals unless `--yes` is passed.

Most users do not need to select an account. If no account is selected, the API uses the actor's default account. Team and client workflows can select an account with `--account <account-id>`, `USERLAND_ACCOUNT_ID`, or `userland accounts use <account-id>`. Platform account members manage apps, releases, secrets, billing, and settings; they are separate from app users inside a published app.

## Validate before publishing

`userland validate <dir>` checks an app directory offline, without an API key:

```sh
userland validate <dir>
userland validate <dir> --json
userland validate <dir> --plan free
userland validate <dir> --plan starter
userland validate <dir> --plan business --json
userland validate <dir> --strict
```

It checks:

- `manifest.userland.json` against the published schema (`schemas/resource-manifest-v0.schema.json`), including auth, data collections, file stores, secrets, jobs, and webhooks, plus the cross-field rules the API applies (index fields must be declared, webhook job targets must exist, signed webhooks need a `secret`).
- Release files and runtime paths: absolute paths, `..` segments, backslashes, `_userland/` paths, missing files, `runtime.static_root` with no files, a `runtime.server_entry` that is not in the release, and per-file and bundle size caps. It warns when a file listed in `files` is a symlink that resolves outside the app directory (publish uploads the target's contents) and when directory publishing skips symlinks.
- Plan limits from `schemas/plans-v0.json`: private apps, app-user auth, public signup, data collection and index counts, file stores and upload sizes, required secrets, scheduled jobs and schedules, webhooks and providers, and release file count and size.

A few schema rules are stricter than the API: unknown keys directly under the top level, `app`, `runtime`, or `resources`; `resources: null`; `null` for `auth.mode`, `jobs.*.trigger`, or `jobs.*.max_attempts`; leading or trailing spaces in tags, secret names, and content types; data index names such as `id`; and empty enum values. The API accepts these today, so validation reports them as `schema_strict` warnings and publishing is not blocked. `--strict` turns them into errors for CI checks against the published schema. A top-level `$schema` key (for editor support) and the CLI keys `files`, `message`, and `provenance` are always allowed.

`--plan` accepts `free`, `starter`, `business`, and `business_plus` (`pro` and `team` are accepted as older names for Starter and Business). Any other value is a usage error that lists the accepted plans. Without `--plan`, validation reports the lowest plan the app needs and lists every plan-gated feature, but does not fail on them. Values that no self-serve plan allows (for example app-user email verification, or more than the Business Plus limits) report `required_plan=internal`, and the message says they are not available on self-serve plans and to contact support. Plan limits are documented at https://docs.userland.fun/reference/limits/.

Human output lists one block per problem:

```text
Validation failed.
manifest=examples/tiny-store/manifest.userland.json
plan=free
plan_source=flag
required_plan=business
release_files=7
release_bytes=9755

manifest_path=resources.auth.public_signup
feature=auth.public_signup
value=true
allowed=false
requires=business
message=Public app-user signup: requires Business.

manifest_path=resources.jobs.expire-abandoned-orders.schedule
limit=jobs.schedule.allowed
value=hourly
allowed=none
requires=business
message=Job schedule: hourly is not allowed on Free (allowed: no scheduled jobs). Requires Business.
```

`--json` prints a stable object for scripts and coding agents:

```json
{
  "ok": false,
  "plan": "free",
  "plan_source": "flag",
  "required_plan_key": "business",
  "violations": [
    {
      "kind": "manifest_feature",
      "manifest_path": "resources.auth.public_signup",
      "feature_key": "auth.public_signup",
      "value": true,
      "allowed": false,
      "plan_key": "free",
      "required_plan_key": "business",
      "message": "Public app-user signup: requires Business."
    }
  ],
  "plan_gated": [],
  "errors": [],
  "warnings": [],
  "manifest_file": "manifest.userland.json",
  "release": { "file_count": 7, "bundle_bytes": 9755 }
}
```

`violations` are checked against the selected plan. `plan_gated` lists everything the Free plan does not include, whether or not `--plan` is passed. `errors` hold schema, path, and file problems with `code`, `manifest_path`, optional `file`, and `message`. Limit violations use `limit_key` instead of `feature_key`, and `allowed` is the plan's limit (a number, a list of allowed schedules, or `null` for unlimited). `required_plan_key` is the lowest self-serve plan that allows a value, or `internal` when none does (the same key the API returns in `402` details); `internal` is not a plan you can select, so contact support for those values. The top-level `required_plan_key` is `null` only when manifest errors prevent the plan check.

Exit codes: `0` valid, `1` manifest, file, or usage errors (including `schema_strict` issues with `--strict`), `2` plan limits exceeded.

`userland apps publish` runs the same validation before uploading anything. It checks plan limits against `--plan` when given, otherwise against the account's own plan and entitlements from `GET /v0/accounts/:account_id/limits` (for `--app` updates, the account that owns the app). Validation errors and plan violations stop the publish with the same output and nothing is uploaded; warnings, including `schema_strict`, print to stderr and do not block. If the account plan cannot be read, the CLI prints a warning and lets the API decide. `--skip-local-validation` sends the directory to the API without local checks.

The Userland API remains authoritative. Local validation mirrors the API's manifest and plan rules for fast feedback; the API can still reject a publish because of billing state, account flags, deployment limits, usage quotas, or newer rules, and returns structured `402` details when it does.

## App Analytics

`userland apps analytics` reads owner-visible aggregate analytics from `GET /v0/apps/:app_id/analytics`:

```sh
userland apps analytics <app-id>
userland apps analytics <app-id> --range 7d
userland apps analytics <app-id> --range 30d
userland apps analytics <app-id> --range 90d
userland apps analytics <app-id> --account <account-id>
userland apps analytics <app-id> --json
userland analytics <app-id>
```

Default output is compact:

```text
app_id=app_...
range=30d
retention_days=30
total_requests=1234
successful_requests=1200
error_requests=34
error_rate=0.0276

status:
2xx  1200
4xx  20
5xx  14

top_paths:
/         500
/pricing  210

top_referrers:
(direct)    700
google.com  250

recent_errors:
2026-06-03T10:00:00.000Z error runtime.exception TypeError: boom
```

API buckets such as `__direct__` (no referrer) print as `(direct)`. Sections with no data are omitted; `auth`, `jobs`, and `webhooks` counts appear when they are non-zero. Without `--range` the API uses 30 days or the plan's retention window, whichever is shorter. When `--range` asks for more, the API clamps the range to the plan's retention window (Starter 7 days, Business 30 days, Business Plus 90 days); the CLI prints a `note=` line when that happens. When no eligible traffic has been served yet, the command says so. `--json` prints the API response unchanged.

App Analytics is a paid feature. Accounts without it get an upgrade message with the required plan and https://docs.userland.fun/guides/app-analytics, and the command exits `1`; with `--json`, stdout also carries `{ "app_id", "entitlement": { "enabled": false, "plan_key", "required_plan_key" }, "error", "docs" }`. `403` and `404` responses print the API error as other app commands do. `--account` follows the same account selection rules as other app commands.

Status and limits:

```sh
userland accounts status --account <account-id>
userland accounts limits --account <account-id>
userland accounts downgrade preview --to starter --account <account-id>
userland apps status <app-id> --account <account-id>
```

`accounts limits` includes plan features, manifest limits, deployment limits, runtime limits, release limits, usage limits, current usage, and route counts.

Support requests:

```sh
userland support open --subject "Deploy failed" --message "The latest release is throwing errors." --app <app-id>
printf '%s\n' "Details from logs or terminal output." | userland support open --subject "Runtime errors" --app <app-id>
userland support open --subject "Billing question" --message "Please look at this account." --account <account-id>
```

`support open` sends a request to Userland support using the selected account. The response includes a `correlation_id` for follow-up; pass `--json` when scripting.

Route management:

```sh
userland apps routes list <app-id> --account <account-id>
userland apps slugs list <app-id> --account <account-id>
userland apps slugs add <app-id> <slug> --account <account-id>
userland apps slugs remove <app-id> <slug> --account <account-id>
userland apps domains list <app-id> --account <account-id>
userland apps domains add <app-id> <hostname> --account <account-id>
userland apps domains verify <app-id> <hostname> --account <account-id>
userland apps domains remove <app-id> <hostname> --account <account-id>
```

Structured API errors keep details on separate lines:

```text
API 402: Monthly request quota exceeded for the current plan.
error=quota_exceeded
metric=requests.monthly.max
plan_key=free
limit=10000
current=10000
upgrade_required=true
```

## Validation

Build and inspect the publish tarball:

```sh
npm run cli:build
npm run cli:pack
```

`schemas/plans-v0.json` is generated from the Userland API's plan configuration; do not edit it by hand. `cli/tests/fixtures/plan-parity.json` holds expected plan results computed by the API's own rules, and `cli/tests/validation.test.ts` checks the CLI against them. `npm run cli:build` copies both schema files into `cli/dist/schemas` so the published package validates offline.

Run command-level CLI tests against a mocked API:

```sh
npm run cli:test
```

Run the full public repo validation suite:

```sh
npm run typecheck
npm test
```

## Sync and release policy

For launch, this `cli/` directory is the public CLI source of truth for agents and publishes as `@userland.fun/cli`. When changing the CLI:

1. Update `cli/src/index.ts` (and `cli/src/validation.ts` for local validation), this README, and `https://docs.userland.fun/reference/cli` together.
2. Add or update mocked command tests in `cli/tests`.
3. Run `npm run typecheck`, `npm run cli:test`, and `npm test`.
4. Update the public repo changelog and the docs changelog.

Compatibility:

| CLI package | API version | Distribution |
|---|---|---|
| `@userland.fun/cli` | Userland API v0 | `npm install -g @userland.fun/cli` |

Do not commit API keys or app secrets.

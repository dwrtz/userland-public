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
printf '%s' "$USERLAND_API_KEY" | userland auth save-key
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
userland apps unpublish <app-id>
printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>
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
printf '%s' "$USERLAND_API_KEY" | npm run userland -- auth save-key
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
npm run userland -- apps unpublish <app-id>
printf '%s' "$VALUE" | npm run userland -- apps secrets set <app-id> <NAME>
npm run userland -- apps events <app-id>
npm run userland -- apps analytics <app-id> --range 30d
npm run userland -- apps routes list <app-id>
npm run userland -- apps slugs add <app-id> <slug>
npm run userland -- apps domains add <app-id> <hostname>
npm run userland -- apps domains verify <app-id> <hostname>
```

`login` starts a browser device-authorization flow. The CLI prints a verification URL and user code, opens the browser when possible, waits for approval, then saves the returned API key to `~/.userland/credentials.json` with `0600` permissions. `signup` is an alias for the same flow; if the email is new, account creation happens in the browser after email proof.

The CLI does not store platform passwords. App commands prefer `USERLAND_API_KEY` when it is set, then fall back to the saved API key. `auth save-key` remains available for CI, support, and manually copied API keys.

### Keys, API URLs, and secrets

- An API key is always paired with the API it belongs to. `USERLAND_API_KEY` is sent to `USERLAND_API_BASE_URL`, or to `https://api.userland.fun` when that is not set; it is never sent to a URL saved in `~/.userland/credentials.json`. A saved key is sent only to the API it was saved with. If `USERLAND_API_BASE_URL` names a different API than the saved key's, the command stops with an error instead of sending the key there. When a saved key is used with an API other than `https://api.userland.fun`, the CLI prints a `note=api_base_url` line on stderr.
- `login`, `signup`, and `auth save-key` use `--api-base-url`, then `USERLAND_API_BASE_URL`, then `https://api.userland.fun`. They do not reuse a URL saved by an earlier login.
- API and console URLs must use `https://`. Plain `http://` is accepted only for `localhost`, `*.localhost`, `127.0.0.1`, and `[::1]`, for local development.
- `login` only opens (or prints) a sign-in link that uses `https://`. For the default API, or when `USERLAND_CONSOLE_URL` is set, the link must also be on the Userland console; otherwise login stops before anything is opened.
- Each `login` creates a new API key. When it replaces a key saved by an earlier `login` for the same API, the CLI revokes the old key and prints `revoked_previous_api_key_id=`. The key it revokes is the one in the credentials file right before the new key is saved, so when two logins run at once (for example parallel agents), each revokes the key it actually replaced. If that fails, the login still succeeds and a `warning=previous_api_key_not_revoked` line names the key to revoke. Keys saved with `auth save-key` are never revoked this way.
- `auth logout` removes the saved key but does not revoke it unless you pass `--revoke`; it prints a `note=api_key_still_active` line when the key still works.
- Pass secret values and API keys on stdin, not as flags, so they stay out of shell history and process lists: `printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>` and `printf '%s' "$USERLAND_API_KEY" | userland auth save-key`. In a terminal, `auth save-key` asks for the key without showing it. `--value` and `--api-key` still work but print a warning.
- The credentials file is written with `0600` permissions through a temporary file in the same folder, so a failed write never leaves a half-written file. The CLI sets the folder to `0700` only when it creates the folder or it is `~/.userland`; a folder named by `USERLAND_CREDENTIALS_FILE` keeps its permissions. A credentials file that is not valid JSON is reported by path, without quoting its contents.
- Empty flag values (`--app ""`, `--account ""`, a flag with no value) are usage errors, so a script with an unset variable never publishes a new app or picks another account by accident. Empty `USERLAND_*` environment variables count as unset.
- `--value`, `--message`, `--subject`, and `--name` accept text that starts with dashes, such as a PEM key (`-----BEGIN PRIVATE KEY-----`). Only a value that is exactly another option, as in `--value --account acct_1`, is refused as a missing value. Other flags, such as `--app` and `--account`, refuse any value that starts with `--`.
- An app id, slug, domain, API key id, or account id of `.` or `..` is refused before anything is sent. In a web address those would change which API path the request goes to: `apps slugs remove <app-id> ..` would unpublish the whole app, and `--app .` would create a new one.
- Text from the API (event messages, app names, error messages) is shown with control characters as visible escapes such as `\x1b`, so it cannot change your terminal. `--json` output is unchanged.

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
- Release files and runtime paths: absolute paths, `..` segments, backslashes, `_userland/` paths, missing files, symlinks listed in `files`, private keys in the folder, `runtime.static_root` with no files, a `runtime.server_entry` that is not in the release, and per-file and bundle size caps. It warns about the dotfiles and symlinks a folder publish leaves out (see "What gets uploaded" below).
- Plan limits from `schemas/plans-v0.json`: private apps, app-user auth, public signup, data collection and index counts, file stores and upload sizes, required secrets, scheduled jobs and schedules, webhooks and providers, and release file count and size.

A few schema rules are stricter than the API: unknown keys directly under the top level, `app`, `runtime`, or `resources`; `resources: null`; `null` for `auth.mode`, `jobs.*.trigger`, or `jobs.*.max_attempts`; leading or trailing spaces in tags, secret names, and content types; data index names such as `id`; and empty enum values. The API accepts these today, so validation reports them as `schema_strict` warnings and publishing is not blocked. `--strict` turns them into errors for CI checks against the published schema. `userland validate` accepts a top-level `$schema` key (for editor support) and the CLI keys `files`, `message` (the release message; `apps publish --message` overrides it), and `provenance`, and never reports them as unknown keys. The CLI ignores a `$schema`, `message`, or `provenance` of the wrong type when publishing (and so does the API for `message`), so a wrong type there is also a `schema_strict` warning; a malformed `files` list is an error because it changes which files are uploaded.

`--plan` accepts `free`, `starter`, `business`, and `business_plus` (`pro` and `team` are accepted as older names for Starter and Business). Any other value is a usage error that lists the accepted plans. Without `--plan`, validation reports the lowest plan the app needs and lists every plan-gated feature, but does not fail on them. Values that no self-serve plan allows (for example app-user email verification, or more than the Business Plus limits) report `required_plan=internal`, and the message says they are not available on self-serve plans and to contact support. Plan limits are documented at https://docs.userland.fun/reference/limits/.

Human output lists one block per problem. This is the complete output for `userland validate examples/webhook-automation --plan free`, which exits `2`:

```text
Validation failed.
manifest=examples/webhook-automation/manifest.userland.json
plan=free
plan_source=flag
required_plan=starter
release_files=7
release_bytes=17631

manifest_path=resources.webhooks
feature=webhooks.enabled
value=1
allowed=false
requires=starter
message=Webhooks: requires Starter.

manifest_path=resources.webhooks.automation.provider
feature=webhooks.provider.generic_hmac
value=generic_hmac
allowed=false
requires=starter
message=Generic HMAC webhooks: requires Starter.

manifest_path=resources.webhooks
limit=webhooks.declared.max
value=1
allowed=0
requires=starter
message=Webhooks: 1 exceeds the Free limit of 0. Requires Starter.

Next steps:
- Change or remove the manifest values above, or use a plan that includes them (Starter).
- Check against that plan: userland validate examples/webhook-automation --plan starter
- The Userland API enforces plan limits authoritatively when you publish.
Docs: https://docs.userland.fun/reference/limits/
```

`--json` prints a stable object for scripts and coding agents. The same check as JSON:

```json
{
  "ok": false,
  "plan": "free",
  "plan_source": "flag",
  "required_plan_key": "starter",
  "violations": [
    {
      "kind": "manifest_feature",
      "manifest_path": "resources.webhooks",
      "feature_key": "webhooks.enabled",
      "value": 1,
      "allowed": false,
      "plan_key": "free",
      "required_plan_key": "starter",
      "message": "Webhooks: requires Starter."
    },
    {
      "kind": "manifest_feature",
      "manifest_path": "resources.webhooks.automation.provider",
      "feature_key": "webhooks.provider.generic_hmac",
      "value": "generic_hmac",
      "allowed": false,
      "plan_key": "free",
      "required_plan_key": "starter",
      "message": "Generic HMAC webhooks: requires Starter."
    },
    {
      "kind": "manifest_limit",
      "manifest_path": "resources.webhooks",
      "limit_key": "webhooks.declared.max",
      "value": 1,
      "allowed": 0,
      "plan_key": "free",
      "required_plan_key": "starter",
      "message": "Webhooks: 1 exceeds the Free limit of 0. Requires Starter."
    }
  ],
  "plan_gated": [
    {
      "kind": "manifest_feature",
      "manifest_path": "resources.webhooks",
      "feature_key": "webhooks.enabled",
      "value": 1,
      "allowed": false,
      "plan_key": "free",
      "required_plan_key": "starter",
      "message": "Webhooks: requires Starter."
    },
    {
      "kind": "manifest_feature",
      "manifest_path": "resources.webhooks.automation.provider",
      "feature_key": "webhooks.provider.generic_hmac",
      "value": "generic_hmac",
      "allowed": false,
      "plan_key": "free",
      "required_plan_key": "starter",
      "message": "Generic HMAC webhooks: requires Starter."
    },
    {
      "kind": "manifest_limit",
      "manifest_path": "resources.webhooks",
      "limit_key": "webhooks.declared.max",
      "value": 1,
      "allowed": 0,
      "plan_key": "free",
      "required_plan_key": "starter",
      "message": "Webhooks: 1 exceeds the Free limit of 0. Requires Starter."
    }
  ],
  "errors": [],
  "warnings": [],
  "manifest_file": "manifest.userland.json",
  "release": {
    "file_count": 7,
    "bundle_bytes": 17631
  }
}
```

`violations` are checked against the selected plan. `plan_gated` lists everything the Free plan does not include, whether or not `--plan` is passed. `errors` hold schema, path, and file problems with `code`, `manifest_path`, optional `file`, and `message`. Limit violations use `limit_key` instead of `feature_key`, and `allowed` is the plan's limit (a number, a list of allowed schedules, or `null` for unlimited). `required_plan_key` is the lowest self-serve plan that allows a value, or `internal` when none does (the same key the API returns in `402` details); `internal` is not a plan you can select, so contact support for those values. The top-level `required_plan_key` is `null` only when manifest errors prevent the plan check.

For the same manifest, the CLI and the API's `402` `details.violations` agree on which `feature_key` and `limit_key` values are violated, on the highest `required_plan_key` for each key, and on the overall required plan. Individual entries can differ: the CLI reports each job, data collection, or file store on its own (so two scheduled jobs can give two `jobs.schedule.allowed` entries, one per schedule, with different `required_plan_key` values), where the API reports one combined entry per key. Release file count and size (`kind: release_limit`) are not part of the API's `details.violations`; the API reports them as a separate `plan_limit_exceeded` error with the same `limit_key` and `required_plan_key`. `message` is the CLI's own wording (it includes the value, the plan limit, and the plan that allows it), so do not compare it with the API's text, and `manifest_path` uses dotted paths such as `resources.webhooks.automation.provider` where the API uses JSON pointers. Both use the same rule for the plan: "requires <Plan>" for a self-serve plan, otherwise "not available on self-serve plans; contact support".

Exit codes: `0` valid, `1` manifest, file, or usage errors (including `schema_strict` issues with `--strict`), `2` plan limits exceeded.

### What gets uploaded

Without a `files` list in `manifest.userland.json`, `apps publish <dir>` uploads every regular file in the folder except:

- `manifest.userland.json` itself (or a top-level `manifest.json` that is the Userland manifest under its older name). Any other `manifest.json`, such as a web app manifest in `public/`, is uploaded like any other file. A top-level `manifest.json` without `app`, `runtime`, `resources`, or `files` is treated as an ordinary file.
- Names that start with a dot, such as `.env`, `.env.local`, `.npmrc`, `.git/`, and `.DS_Store`, at any depth, because they often hold passwords and keys. `.well-known/` folders are still uploaded, and so are dot-folders that `runtime.static_root` or `runtime.server_entry` name (for example a `static_root` of `.output/public`). A `warning=dotfiles_skipped` line lists what was left out.
- Symlinks, which are never followed (`warning=symlinks_skipped`).

A folder that holds a private key (`id_rsa`, `id_ed25519`, and similar, `.p12` or `.pfx` files, or a `.pem` or `.key` file containing a private key) is not published: the command stops with `error=private_key` and names the file. Publish a build folder instead, or move the key out.

With a `files` list, exactly those files are uploaded, including dotfiles you list on purpose. Each listed path must be a regular file inside the app folder: a listed symlink, or a file inside a symlinked folder, stops the publish with `error=symlink`, so a copied template cannot make a file from elsewhere on your computer public. These checks also run with `--skip-local-validation`, before anything is read or sent.

`userland apps publish` runs the same validation before uploading anything. It checks plan limits against `--plan` when given, otherwise against the account's own plan and entitlements from `GET /v0/accounts/:account_id/limits` (for `--app` updates, the account that owns the app). Validation errors and plan violations stop the publish with the same output and nothing is uploaded; warnings, including `schema_strict`, print to stderr and do not block. If the account plan cannot be read, the CLI prints a warning and lets the API decide. `--skip-local-validation` skips the manifest and plan checks and lets the API decide. The file checks under [What gets uploaded](#what-gets-uploaded) still run with it: dotfiles are still left out, and unsafe paths, symlinks, missing files, and private keys still stop the publish, and nothing is sent.

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

`accounts limits` includes plan features, manifest limits, deployment limits, runtime limits, release limits, usage limits, current usage, and route counts. `accounts downgrade preview --to` takes the same plans as `validate --plan`: `free`, `starter`, `business`, or `business_plus`.

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

When the app's server does not start in time during a rollback (for example, right after publishing a newer release), the error says why and what to do. The app stays on the release it was on, so run the same command again:

```text
API 502: User Worker activation probe failed.
error=platform_deploy_failed
reason=runtime_unavailable
status=503
attempts=10
Your app's server is still being updated. Run the same command again in a minute.
```

## Unpublish an app

`userland apps unpublish` removes an app you no longer need, such as a test or demo app, with `DELETE /v0/apps/:app_id`:

```sh
userland apps list
userland apps unpublish <app-id>
userland apps unpublish <app-id> --account <account-id>
userland apps unpublish <app-id> --yes
userland apps unpublish <app-id> --yes --json
```

Unpublishing takes the app offline, removes its slugs and custom domains, and removes it from `apps list`. Its release history is kept, and `userland apps releases <app-id>` still lists it. Check the app id with `userland apps list` first: each line shows the app id, live release, last update, name, and address.

In a terminal, the command first shows the app's name, address, id, account, and whether it is a production app, and asks you to type the app id or `y`. Any other answer, or closing the input, cancels: it prints `Cancelled. <app-id> was not unpublished.` and exits `1`. Without a terminal (scripts, CI, and coding agents), check with the app's owner first, then pass `--yes`. Without it the command stops with a usage error before sending anything, and piping `y` on stdin does not count as confirming.

When an account is selected (with `--account`, `USERLAND_ACCOUNT_ID`, or the account saved by `userland accounts use`), the command reads the app first, even with `--yes`, and only unpublishes it if it belongs to that account. An app in a different account is left alone: the command prints `<app-id> belongs to account <other-account-id>, not <account-id>. Nothing was unpublished.` and exits `1`. With no account selected, the command unpublishes the app in whichever of your accounts it belongs to, as long as your role there is owner or admin.

Output:

```text
Unpublished Old test app (https://<app_id>.apps.userland.fun/)
app_id=<app_id>
status=unpublished
deleted_at=2026-09-28T00:00:00.000Z
The app is offline and its slugs and custom domains are removed. Its release history is kept.
```

With `--yes` there is no prompt. When the command has not read the app first (`--yes` with no account selected), the first line is `Unpublished <app_id>`. `--json` prints the API response unchanged (`app_id`, `status`, and `deleted_at`); a prompt, when there is one, goes to stderr so stdout stays JSON. Errors print like other app commands and exit `1`: `API 404` for an app id that does not exist or is already unpublished, `API 403` when your account role cannot remove apps (only owners and admins can) or the app or account is suspended, and `API 451` for an app that is unavailable for legal reasons.

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

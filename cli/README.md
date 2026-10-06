# Userland CLI

This directory is the source for the public `@userland.fun/cli` npm package.

Docs:

- https://docs.userland.fun/llms.txt
- https://docs.userland.fun/reference/cli
- https://docs.userland.fun/guides/troubleshooting

Requires Node.js 20 or newer. Check with `node --version`; if Node is missing or older, install the current LTS release from https://nodejs.org/ first.

Install globally:

```sh
npm install -g @userland.fun/cli
```

If a global install fails with a permission error (`EACCES`), run the CLI without installing it: `npx @userland.fun/cli --version`, then use `npx @userland.fun/cli` in place of `userland` in the commands below.

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
userland apps download <app-id>
userland apps export <app-id>
userland apps unpublish <app-id>
userland apps secrets list <app-id>
printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>
userland apps secrets delete <app-id> <NAME>
userland apps invites create <app-id> --email <email> --role <role>
userland apps events <app-id>
userland apps events <app-id> --cursor <cursor>
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
npm run userland -- apps download <app-id>
npm run userland -- apps export <app-id>
npm run userland -- apps unpublish <app-id>
npm run userland -- apps secrets list <app-id>
printf '%s' "$VALUE" | npm run userland -- apps secrets set <app-id> <NAME>
npm run userland -- apps secrets delete <app-id> <NAME>
npm run userland -- apps invites create <app-id> --email <email> --role <role>
npm run userland -- apps events <app-id>
npm run userland -- apps events <app-id> --cursor <cursor>
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

- `manifest.userland.json` against the published schema (`schemas/resource-manifest-v0.schema.json`), including auth, data collections, file stores, secrets, jobs, and webhooks, plus the cross-field rules the API applies (index fields must be declared, webhook job targets must exist, signed webhooks need a `secret`). A webhook's `provider` is `none`, `generic_hmac`, `github`, or `stripe`; every one but `none` is signed, and its `secret` names the secret that holds the signing key (for `stripe`, the signing secret Stripe shows for the endpoint, `whsec_...`). CLI 0.10.0 and earlier refuse `stripe` (`message=must be "none"` for the webhook's `provider`).
- `runtime.embed_origins`, the other sites allowed to show the app in a frame on its `*.apps.userland.fun` addresses, with the API's rules and messages. Each entry is `https://`, a domain name, and an optional port, optionally starting with `*.` to cover subdomains (`https://www.example.com`, `https://*.example.com`), with no path or trailing slash. At most 20 entries, and no IP addresses, `localhost`, `*`, `'self'`, or Userland addresses (other apps, slugs, anything under `userland.fun` or `userland.link`, docs, the console, the API). Every bad entry gets its own `error=invalid_runtime_manifest` block (the API stops at the first). When the list is valid, the output shows the sites as the API stores them, in lowercase without repeats: `embed_origins=https://www.example.com,https://*.example.com`.
- Release files and runtime paths: absolute paths, `..` segments, backslashes, `_userland/` paths, missing files, symlinks listed in `files`, private keys in the folder, `runtime.static_root` with no files, a `runtime.server_entry` that is not in the release, and per-file and bundle size caps. It warns about the dotfiles and symlinks a folder publish leaves out (see "What gets uploaded" below).
- Plan limits from `schemas/plans-v0.json`: app-user auth, public signup, data collection and index counts, file stores and upload sizes, required secrets, scheduled jobs and schedules, webhooks and providers, and release file count and size.

A few schema rules are stricter than the API: unknown keys directly under the top level, `app`, `runtime`, or `resources`; `resources: null`; `null` for `auth.mode`, `jobs.*.trigger`, or `jobs.*.max_attempts`; leading or trailing spaces in tags, secret names, and content types; data index names such as `id`; empty enum values; and repeated `runtime.embed_origins` entries or ones that start with `HTTPS://` in capital letters. The API accepts these today, so validation reports them as `schema_strict` warnings and publishing is not blocked. `--strict` turns them into errors for CI checks against the published schema. `userland validate` accepts a top-level `$schema` key (for editor support) and the CLI keys `files`, `message` (the release message; `apps publish --message` overrides it), and `provenance`, and never reports them as unknown keys. The CLI ignores a `$schema`, `message`, or `provenance` of the wrong type when publishing (and so does the API for `message`), so a wrong type there is also a `schema_strict` warning; a malformed `files` list is an error because it changes which files are uploaded.

`--plan` accepts `free`, `starter`, `business`, and `business_plus` (`pro` and `team` are accepted as older names for Starter and Business). Any other value is a usage error that lists the accepted plans. Without `--plan`, validation reports the lowest plan the app needs and lists every plan-gated feature, but does not fail on them. Values that no self-serve plan allows (for example app-user email verification, or more than the Business Plus limits) report `required_plan=internal`, and the message says they are not available on self-serve plans and to contact support. Plan limits are documented at https://docs.userland.fun/reference/limits/.

Human output lists one block per problem. This is the complete output for `userland validate examples/webhook-automation --plan free`, which exits `2`:

```text
Validation failed.
manifest=examples/webhook-automation/manifest.userland.json
plan=free
plan_source=flag
required_plan=starter
release_files=7
release_bytes=18224

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
    "bundle_bytes": 18224
  },
  "embed_origins": []
}
```

`violations` are checked against the selected plan. `plan_gated` lists everything the Free plan does not include, whether or not `--plan` is passed. `errors` hold schema, path, and file problems with `code`, `manifest_path`, optional `file`, and `message`. Limit violations use `limit_key` instead of `feature_key`, and `allowed` is the plan's limit (a number, a list of allowed schedules, or `null` for unlimited). `required_plan_key` is the lowest self-serve plan that allows a value, or `internal` when none does (the same key the API returns in `402` details); `internal` is not a plan you can select, so contact support for those values. The top-level `required_plan_key` is `null` only when manifest errors prevent the plan check. `embed_origins` lists the sites allowed to show the app in a frame, as the API stores them: `[]` when `runtime.embed_origins` is empty or left out, and `null` when manifest errors prevent the check.

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

### Publish output

`apps publish` starts with `Published <address>` only when the new release is live. A release can also be stored without going live: `activation_status` is then `pending_secrets` (a required secret is not set), `requires_migration` (a change to saved data needs a migration first), or `failed` (the server code could not be started). The output then starts with `Stored, not live`, one `Why:` line for each reason, what the app's address shows now, and the commands to run next:

```text
Stored, not live: this release is not serving yet.
Why: Required secret STRIPE_SECRET_KEY is not set.
The previous release (rel_old) is still live at https://<app_id>.apps.userland.fun/
Next: printf '%s' "$VALUE" | userland apps secrets set <app_id> STRIPE_SECRET_KEY
      or the owner adds it at https://console.userland.fun/apps/<app_id>/settings?add-key=STRIPE_SECRET_KEY
Next: userland apps publish <dir> --app <app_id>
Docs: https://docs.userland.fun/guides/secrets
app_id=<app_id>
release_id=rel_new
previous_release_id=rel_old
activation_status=pending_secrets
activation_reasons=Required secret STRIPE_SECRET_KEY is not set.
```

On a first publish there is no previous release, so that line says the address does not show the app yet. Setting the secret does not make this release live: set it, then publish again with `--app`. The console link appears when the CLI knows the console (the default API, a console saved by `userland login`, or `USERLAND_CONSOLE_URL`). A release that is live while billing or the plan has turned the app's address off prints `Published <address>`, then a line saying visitors can't open it, and `Next: userland accounts status`.

The `key=value` lines are the same in every case, so scripts can keep reading `activation_status`. The exit code is `0` whenever the release was stored, live or not: run the next commands rather than publishing again without `--app`, which would create a second app. `inactive` appears only in `apps releases`, never in publish output. CLI 0.11.0 and earlier print `Published <address>` for every stored release, so check `activation_status` there. `cli/tests/fixtures/activation-results.json` lists each result, what it means, and the exact output.

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

App Analytics is a paid feature. Accounts without it get an upgrade message with the required plan, the console link to send the owner (`upgrade_url`, or `support_url` when no plan on sale includes it), and https://docs.userland.fun/guides/app-analytics, and the command exits `1`; with `--json`, stdout also carries `{ "app_id", "entitlement": { "enabled": false, "plan_key", "required_plan_key" }, "error", "docs" }`. `403` and `404` responses print the API error as other app commands do. `--account` follows the same account selection rules as other app commands.

Status and limits:

```sh
userland accounts status --account <account-id>
userland accounts limits --account <account-id>
userland accounts downgrade preview --to starter --account <account-id>
userland apps status <app-id> --account <account-id>
```

`accounts limits` includes plan features, manifest limits, deployment limits, runtime limits, release limits, usage limits, current usage, and route counts. Usage is this period's counter unless a `usage_source=` line says otherwise: `usage_source=files.storage_bytes.max value=stored_files` means that number is the size of every file the account stores now, which does not reset each month. `short_address_holds=held` and `short_address_holds=max` say how many removed short addresses the account holds now and can hold at a time (`unlimited` when its plan has no limit; see Route management). `accounts downgrade preview --to` takes the same plans as `validate --plan`: `free`, `starter`, `business`, or `business_plus`.

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

A slug is the app's short address on apps.userland.fun. When you remove one with `apps slugs remove`, or unpublish its app, the account keeps it for 30 days: any of the account's own apps can add it again, and another account that adds it gets `API 409` with `error=route_hostname_taken`, as for a short address in use. `apps slugs remove` prints the removed route, whose `verification=` line has `held_for_account_until`, when the hold ends. An account holds at most as many removed short addresses at a time as its plan includes, and at least one (`short_address_holds` in `accounts limits`); a short address removed past that is not kept, so anyone can add it at once, and its `verification=` line has no `held_for_account_until`. Unpublishing an app also removes its short addresses and custom domains that a smaller plan or an unpaid invoice turned off, so there is no need to remove them first, and keeps such a short address the same way, after the working ones: when the account can't keep them all, the working ones are kept first. A short address or custom domain that Userland support turned off stays with the unpublished app until support turns it back on or releases it, and its name can't be added to another app. Publishing the app again with its app id brings back none of the ones unpublishing removed: add them again.

A custom domain's route line and its `verification=` line are followed by the DNS records the owner adds at their DNS provider, and what Userland's last check found:

```text
route_123	custom_domain	pending_dns	portal.example.com		
verification={"method":"dns_txt","name":"_userland.portal.example.com","value":"userland-route=route_123","ownership_status":"missing"}
dns_record=traffic type=CNAME name=portal.example.com value=customers.userland.fun
dns_record=ownership_txt type=TXT name=_userland.portal.example.com value=userland-route=route_123
dns_ownership_status=missing
dns_verification_error="Ownership TXT record not found: add _userland.portal.example.com with the value userland-route=route_123."
dns_last_refreshed_at=2026-10-03T09:00:00.000Z
```

Give the owner every `dns_record=` line: `traffic` sends visitors to the app (for a bare domain such as `example.com`, its `note` says which record types work), `ownership_txt` proves the domain is theirs, and `provider_validation` lines, when there are any, let the certificate provider issue HTTPS. `apps domains remove` prints none of these lines, since a removed domain needs no records. Userland checks a waiting domain every hour for 14 days after it is added, so it goes live by itself once the records are right; `apps domains verify` checks now. While a record is still missing, verify answers `API 409` with `error=domain_pending_verification`, the domain's `status`, the same `dns_` lines, and `domain_url`, the console page that shows the owner the domain's setup steps.

Structured API errors keep details on separate lines. Plan refusals carry the console link to send the owner: `upgrade_url` opens the plans page with the plan that fixes it, or `support_url` when no plan on sale does (`self_serve_upgrade=false`). Payment refusals (`billing_restricted`, `downgrade_incompatible`) carry `billing_url`, the account's Plan and billing page, and a domain that is still waiting carries `domain_url`. Send the link to the owner as it is:

```text
API 402: app_slugs requires Starter.
error=entitlement_required
plan_key=free
required_plan_key=starter
self_serve_upgrade=true
upgrade_url=https://console.userland.fun/billing/plans?plan=starter&for=app_slugs&account=acct_123
violation=feature=app_slugs requires=starter
```

When a rollback cannot update the app's server (`error=platform_deploy_failed`), the rollback does not happen and the app stays on the release it was on. The error says why and what to do. When the server did not start in time, which can happen right after publishing a newer release, or the upload could not be taken just then, it says to run the same command again:

```text
API 502: User Worker activation probe failed.
error=platform_deploy_failed
reason=runtime_unavailable
status=503
attempts=10
The rollback did not happen: your app is still on its current release. Run the same command again in a minute.
```

When the upload was refused (for example, the server code is too large) or could not be checked, running the command again fails the same way, so the error prints the reason for the refusal (`upload_error`) and says to send the output to support instead:

```text
API 502: User Worker upload failed.
error=platform_deploy_failed
status=400
upload_error="Your Worker exceeded the size limit of 10 MiB." code=10027
The rollback did not happen: your app is still on its current release. Running the same command again will not fix this. Send this output to support: userland support open --subject "Rollback failed" --app <app-id>
```

## Download an app

```sh
userland apps download <app-id>
userland apps download <app-id> ./my-app
userland apps download <app-id> ./old-copy --version <release-id>
userland apps download <app-id> . --force --json
userland apps pull <app-id>
```

`userland apps download` (alias `apps pull`, CLI 0.13.0 or later) writes one version of an app into a folder that publishes again unchanged with `userland apps publish <dir> --app <app-id>`. Use it when the project folder is lost, when a new coding agent starts without one, or to keep a copy.

- **Which version.** It takes the live version unless you pass `--version` with a release id from `userland apps releases <app-id>`. Any version Userland still keeps works, also for an unpublished app.
- **The folder.** It defaults to `./<app-id>`. A folder that isn't empty needs `--force`; files already there with other names are left alone.
- **What it writes.** Every file of the version at its path, and a `manifest.userland.json` rebuilt from the version's settings and message. The manifest has a `files` list naming every file, with a `content_type` only where the CLI's guess from the extension would differ, so publishing the folder sends exactly the same files with the same types.
- **Checks.** Each file's size and SHA-256 are checked as it arrives, and a file that doesn't match is not kept. A path that would land outside the folder (`..`, an absolute path, a backslash) stops the download before anything is written. Symlinks are never written or followed.
- **Files a few at a time.** It reads files four at a time and waits when the API's file-read limit says to slow down.
- **Account.** When an account is selected (`--account`, `USERLAND_ACCOUNT_ID`, or the saved account), an app in a different account is not downloaded.
- **Who.** Owners, admins and members can download (`API 403` for a viewer). A version Userland no longer keeps answers `API 404`.

```text
Downloaded 5 files of the live version to /Users/me/my-app
app_id=app_...
release_id=rel_...
dir=/Users/me/my-app
file_count=5
required_secret=STRIPE_SECRET_KEY
Not included: the app's saved data, secret values, and files whose names start with a dot (Userland never uploads those). If the app was built before it was published, these are the built files.
Next: userland validate /Users/me/my-app
Next: userland apps publish /Users/me/my-app --app app_...
```

A `required_secret=` line names each secret the version needs. Its value is never downloaded; it stays saved with the app, so publishing the folder again as the same app keeps using it. `--json` prints `app_id`, `account_id`, `release_id`, `is_live`, `message`, `created_at`, `dir`, `file_count`, `total_bytes`, `files` (`path`, `size_bytes`, `sha256`) and `required_secrets`.

A version published before newer rules (for example an embed origin on a Userland address, or a content type an older CLI accepted) may need a change before it publishes again; `userland validate <dir>` says what.

## Export saved data

```sh
userland apps export <app-id>
userland apps export <app-id> ./backup
userland apps export <app-id> ./orders --collection orders
userland apps export <app-id> ./backup --no-files --json
```

`userland apps export` (CLI 0.13.0 or later) saves an app's data into a folder (`./<app-id>-data` by default): the records its server code saved, the people who can sign in, and the files people uploaded. Owners and admins can export, on every plan, also for an unpublished app.

| Path | What it holds |
|---|---|
| `records/<collection>.json` and `.csv` | Every record: its `id`, `created_at`, `updated_at`, `owner_app_user_id`, and its fields (one CSV column per field) |
| `people.json` and `people.csv` | The people who sign in: `id`, `email`, `roles` (separated by `;` in the CSV), `created_at`, `updated_at`, `disabled_at` |
| `files/<store>/<path>` | Each uploaded file, its size and SHA-256 checked |
| `files/index.csv` | Every uploaded file's store, path, content type, size and SHA-256 |
| `README.txt` | What the folder holds |

Each `.json` file is a JSON array with one item per line, so large collections never have to fit in memory. In the CSV files, a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return begins with `'`, so a spreadsheet shows it as text instead of running it. Passwords are never exported: people set a new password on any new system. Secret values and deleted records and files aren't included either.

- `--collection <name>` saves one collection only, without people or files.
- `--no-files` leaves uploaded files out.
- A folder that isn't empty needs `--force`.
- When an account is selected, an app in a different account is not exported.

The output ends with `collections=`, `records=`, `people=`, `files=` and `file_bytes=` lines; `--json` prints the same counts with `app_id`, `account_id` and `dir`.

## Unpublish an app

`userland apps unpublish` removes an app you no longer need, such as a test or demo app, with `DELETE /v0/apps/:app_id`:

```sh
userland apps list
userland apps unpublish <app-id>
userland apps unpublish <app-id> --account <account-id>
userland apps unpublish <app-id> --yes
userland apps unpublish <app-id> --yes --json
```

Unpublishing takes the app offline, removes its slugs and custom domains, and removes it from `apps list`. Its release history is kept, and `userland apps releases <app-id>` still lists it. Slugs and custom domains that a smaller plan or an unpaid invoice turned off are removed too, and the account keeps the removed slugs for 30 days, as described under Route management above. One that Userland support turned off stays with the unpublished app until support turns it back on or releases it. Check the app id with `userland apps list` first: each line shows the app id, live release, last update, name, and address.

In a terminal, the command first shows the app's name, address, id, account, and whether it is a production app, and asks you to type the app id or `y`. Any other answer, or closing the input, cancels: it prints `Cancelled. <app-id> was not unpublished.` and exits `1`. Without a terminal (scripts, CI, and coding agents), check with the app's owner first, then pass `--yes`. Without it the command stops with a usage error before sending anything, and piping `y` on stdin does not count as confirming. The command it suggests running keeps the `--account` you passed.

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

## Secrets

```sh
userland apps secrets list <app-id>
userland apps secrets list <app-id> --json
printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>
userland apps secrets delete <app-id> <NAME>
userland apps secrets delete <app-id> <NAME> --yes --account <account-id>
```

`apps secrets list` prints one tab-separated line for each secret that is set: its name, when it was first set (`created_at`), and when it was last set (`updated_at`). It never shows values. The API does not return them, and the CLI prints only the name and the two dates, also with `--json`, which prints `{ "app_id", "secrets": [{ "name", "created_at", "updated_at" }] }`. When no secrets are set, stdout is empty and stderr says `No secrets are set for <app-id>.`

```text
MODEL_API_KEY	2026-09-01T00:00:00.000Z	2026-09-20T00:00:00.000Z
STRIPE_SECRET_KEY	2026-09-01T00:00:00.000Z	2026-09-20T00:00:00.000Z
```

`apps secrets delete` removes a secret from the app. Server code that reads it stops getting it at once (`ctx.secrets.require` throws `missing_secret`), and the value cannot be shown or brought back; you can only set a new one. Before deleting, check that the app's code no longer reads the secret, and remove it from `resources.secrets.required` in `manifest.userland.json`: otherwise the next release you publish does not go live (its activation status is `pending_secrets`). Setting the secret again does not make that release live; you have to set it and then publish again.

The command first checks that the name is set, and stops with `No secret named <NAME> is set for <app-id>, so nothing was deleted.` and exit code `1` when it is not, so a typo never looks like a success. In a terminal, it then shows the secret, when it was last set, and the app's name, address, id, and account, and asks you to type the secret's name or `y`; any other answer, or closing the input, prints `Cancelled. <NAME> was not deleted.` and exits `1`. Without a terminal (scripts, CI, and coding agents), check with the app's owner first, then pass `--yes`; without it the command stops with a usage error before sending anything, and piping `y` on stdin does not count as confirming. When an account is selected (with `--account`, `USERLAND_ACCOUNT_ID`, or the account saved by `userland accounts use`), the command reads the app first, even with `--yes`, and deletes nothing in an app that belongs to a different account, as `apps unpublish` does. When the command stops for want of `--yes`, the command it suggests keeps the `--account` you passed, so running it still checks the account.

Output:

```text
Deleted secret OPENAI_API_KEY from <app_id>.
secret=OPENAI_API_KEY
present=false
Server code that reads OPENAI_API_KEY no longer gets it. If manifest.userland.json lists it under resources.secrets.required, remove it there too, or the next release you publish does not go live (pending_secrets) until the secret is set and you publish again.
```

`apps secrets set` and `apps secrets delete` check the name before sending anything, with the API's rules: capital letters, numbers, and underscores, starting with a letter, at most 64 characters, and not starting with `USERLAND_`, `CF_`, or `CLOUDFLARE_`, which are kept for Userland. Setting and deleting secrets needs the owner or admin role in the app's account; anyone in the account can list them.

## Invite people to sign in to an app

For an app with sign-in (`resources.auth.mode` is `app_users`), `apps invites create` makes an invite for one person and prints only the invite link:

```sh
userland apps invites create <app-id> --email <email>
userland apps invites create <app-id> --email <email> --role staff
userland apps invites create <app-id> --email <email> --role staff --role owner --expires-in-days 30
userland apps invites create <app-id> --email <email> --role owner --account <account-id> --json
```

```text
https://<app_id>.apps.userland.fun/_userland/auth/invite/<invite_id>?token=inv_...
```

The person opens the link, sets a password, and can then sign in to the app with the roles you gave them. An invite is only for someone who does not have an account in the app yet: the command still prints a link for an email that already has one, but setting a password on it fails with "An app user already exists for this email." (`409 user_exists`) and gives no new role, and the person keeps the password and roles they have. There is no command yet to change the roles of someone who already has an account in the app. People who are invited become users of that app only: the invite does not add them to your Userland account or let them use the CLI or API. Give the link only to that person, because whoever has it can use it once to set the password.

- `--email` (required) is the person's email address.
- `--role` gives the person one of the roles the app's manifest declares in `resources.auth.roles`. Pass it once for each role (`--role staff --role owner`, not `--role staff,owner`). Without `--role`, the person gets no special role.
- `--expires-in-days` sets how long the link works, from `1` to `30` days. Without it the link works for 7 days.
- `--json` prints the API response unchanged: `invite_id`, `email`, `roles`, `expires_at`, and `invite_url`.

The command works with the key saved by `userland login` as well as with `USERLAND_API_KEY`, so you do not need to make another API key to invite someone. It needs the owner or admin role in the app's account. When an account is selected (with `--account`, `USERLAND_ACCOUNT_ID`, or the account saved by `userland accounts use`), the command reads the app first and creates no invite for an app that belongs to a different account: it prints `<app-id> belongs to account <other-account-id>, not <account-id>. No invite was created.` and exits `1`, as `apps unpublish` does. Errors print like other app commands and exit `1`, with no invite link: `API 409` with `error=auth_disabled` when the app does not have sign-in, `API 400` with `error=invalid_role` for a role the app does not declare, and `API 402` with `error=quota_exceeded` and `metric=app_users.active.max` when the app has as many people as its plan allows. That one carries `upgrade_url`, the plans page to send the owner (or `support_url` with `self_serve_upgrade=false` when no plan on sale allows more people):

```text
API 402: app_users.active.max quota exceeded for the current plan.
error=quota_exceeded
metric=app_users.active.max
plan_key=free
required_plan_key=starter
limit=10
current=10
increment=1
upgrade_required=true
self_serve_upgrade=true
upgrade_url=https://console.userland.fun/billing/plans?plan=starter&for=app_users.active.max&account=acct_123
```

## Read events

```sh
userland apps events <app-id>
userland apps events <app-id> --severity error --limit 25
userland apps events <app-id> --type job.failed
userland apps events <app-id> --release <release-id>
userland apps events <app-id> --severity error --limit 25 --cursor <cursor>
```

`apps events` prints one tab-separated line for each event, newest first: when it happened, its severity, its type, the release id, and the message. `--limit` takes `1` to `100` (the default is `100`). When there are more events than fit, the last line is `cursor=<cursor>`. To read the next, older page, run the same command again with `--cursor <cursor>` added, keeping the other options the same; the last page has no `cursor=` line.

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

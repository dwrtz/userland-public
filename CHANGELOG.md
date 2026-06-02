# Changelog

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

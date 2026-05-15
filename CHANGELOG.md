# Changelog

## Unreleased

## 0.2.0 - 2026-05-15

- Add CLI operations commands for app status, events, routes, secrets, limits, and rollback workflows.
- Fix phase 8 CLI operations controls.

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

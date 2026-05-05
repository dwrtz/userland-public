---
name: userland-debug-migrate
description: Userland activation, runtime, resource migration, job, webhook, and rollback debugging.
---

# Userland debug and migrate

Userland API version: v0

Use this skill when activation, runtime behavior, resources, jobs, webhooks, or migrations fail.

## Inputs

- App id and release id.
- Activation status and reasons.
- Events from the API or CLI.
- Current and proposed manifests.

## Outputs

- Root cause summary.
- Minimal fix.
- Validation steps.
- Rollback or forward-fix recommendation.

## Steps

1. Read events for the app.
2. Compare manifest resource declarations with runtime code.
3. Check missing files, bad runtime paths, missing secrets, invalid jobs, and invalid webhooks.
4. Prefer a small forward fix when state is compatible.
5. Roll back when the live release is broken and a known-good release exists.

## Commands

```sh
USERLAND_API_KEY=... npm run userland -- apps events <app-id> --limit 50
USERLAND_API_KEY=... npm run userland -- apps releases <app-id>
USERLAND_API_KEY=... npm run userland -- apps rollback <app-id> <release-id>
```

## Validation checklist

- Every runtime file referenced by the manifest exists.
- Every `ctx` resource access has a matching resource declaration.
- Required secrets are set before runtime paths need them.
- Job and webhook names match the manifest exactly.

## Safety rules

- Do not delete user data to hide migration issues.
- Do not expose logs containing secrets.
- Do not guess undocumented event meanings.
- Roll back before broad rewrites when production is broken.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

---
name: userland-manifest-resources
description: Userland manifest resources for auth, data, files, secrets, jobs, and webhooks.
---

# Userland manifest resources

Userland API version: v0

Use this skill when declaring `manifest.userland.json` resources.

## Inputs

- Required app capabilities.
- Data model, access rules, file stores, secrets, jobs, and webhooks.
- Existing manifest if adapting an app.

## Outputs

- A valid `resources` object for Userland v0.
- Runtime notes for how server code should use declared resources.

## Steps

1. Start from https://docs.userland.fun/reference/resource-manifest.
2. Declare only resources the app actually needs.
3. Use `auth` for app users and roles.
4. Use `data.collections` for durable structured state.
5. Use `files.stores` for uploads.
6. Use `secrets.required` for server-only secrets.
7. Use `jobs` and `webhooks` only when server code handles them.

## Commands

```sh
npm run validate:manifests
```

## Validation checklist

- Collection, field, index, job, webhook, and store names are stable.
- Access rules match the app threat model.
- Required secrets are documented for the operator.
- Runtime code only uses resources declared in the manifest.

## Safety rules

- Do not store secrets in `manifest.userland.json`.
- Do not expose secret values in static code.
- Do not create undeclared resources at runtime.
- Do not publish files under `_userland/`.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

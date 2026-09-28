---
name: userland-manifest-resources
description: Userland manifest resources for auth, data, files, secrets, jobs, and webhooks.
---

# Userland manifest resources

Userland API version: v0

Use this skill when declaring `manifest.userland.json` resources, or the sites allowed to show the app in a frame (`runtime.embed_origins`).

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
8. Add `runtime.embed_origins` only when the user's own website must show the app inside its pages in an `<iframe>`. By default no other site or Userland app can show an app on `*.apps.userland.fun` in a frame. List the user's sites, for example `"embed_origins": ["https://www.<customer-domain>", "https://*.<customer-domain>"]`: each entry is `https://`, a domain name, and an optional port, optionally starting with `*.` for subdomains, with no path or trailing slash, and at most 20 entries. Inside the frame the app runs signed out, so embed public pages and link to the app for anything that needs sign-in. See https://docs.userland.fun/guides/embedding/.

## Commands

```sh
npm run validate:manifests
```

## Validation checklist

- Collection, field, index, job, webhook, and store names are stable.
- Access rules match the app threat model.
- Required secrets are documented for the operator.
- Runtime code only uses resources declared in the manifest.
- `runtime.embed_origins` lists only sites the user owns and asked to embed the app on; `userland validate` reports any entry the API would refuse.

## Safety rules

- Do not store secrets in `manifest.userland.json`.
- Do not expose secret values in static code.
- Do not create undeclared resources at runtime.
- Do not publish files under `_userland/`.
- Never list another Userland app or address (`*.apps.userland.fun`, `userland.fun`, docs, the console) in `runtime.embed_origins`, and never try to allow every site; the API refuses both.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

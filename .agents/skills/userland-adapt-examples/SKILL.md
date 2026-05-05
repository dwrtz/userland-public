---
name: userland-adapt-examples
description: Userland examples adaptation workflow for cloning patterns into a new app.
---

# Userland adapt examples

Userland API version: v0

Use this skill when copying a Userland example into a new app.

## Inputs

- Target app idea.
- Chosen example from `catalog.json`.
- Desired changes from the user.

## Outputs

- Adapted app directory.
- Updated manifest, README, and AGENT notes.
- Validation and publish instructions.

## Steps

1. Choose the closest example by capability, not by visual similarity.
2. Copy only the files needed for the target app.
3. Rename app metadata, collections, stores, jobs, and webhooks to match the new app.
4. Remove unused resources.
5. Update docs and operator instructions.
6. Validate before publishing.

## Commands

```sh
npm run validate:catalog
npm run validate:manifests
USERLAND_API_KEY=... npm run userland -- apps publish examples/<new-example-slug>
```

## Validation checklist

- The new example has `README.md`, `AGENT.md`, `example.json`, and `manifest.userland.json`.
- `catalog.json` entry matches `example.json`.
- No copied secret names remain unless still required.
- App name, summary, tags, and routes match the target app.

## Safety rules

- Do not leave sample secrets in adapted code.
- Do not preserve irrelevant admin routes.
- Do not publish until unused resources are removed.
- Keep provenance clear when adapting an example.

## References

- Agent context: https://docs.userland.fun/llms.txt
- CLI docs: https://docs.userland.fun/reference/cli
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Public CLI source: https://github.com/dwrtz/userland-public/tree/main/cli

# Hello Static

A one-page static site: HTML and CSS only, with no server code, stored data, or secrets.

Use it when the app only needs pages, styles, browser JavaScript, and images.

## Plan

**Plan needed: Free.** Nothing in this example needs a paid plan.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/hello-static
```

The publish output includes the app id, the app address (`https://<app-id>.apps.userland.fun/`), the new release, and whether it is live.

## Change or undo a release

```sh
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
```

## Userland docs

- Agent context: https://docs.userland.fun/llms.txt
- From an example: https://docs.userland.fun/quickstarts/from-example
- Resource manifest: https://docs.userland.fun/reference/resource-manifest
- Runtime ctx: https://docs.userland.fun/reference/runtime-ctx
- CLI: https://docs.userland.fun/reference/cli
- Agent skills: https://docs.userland.fun/reference/agent-skills
- Troubleshooting: https://docs.userland.fun/guides/troubleshooting
- Plan limits: https://docs.userland.fun/reference/limits

Capability docs:

- Static quickstart: https://docs.userland.fun/quickstarts/static-app
- Rollback: https://docs.userland.fun/guides/rollback

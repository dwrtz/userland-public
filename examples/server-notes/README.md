# Server Notes

A small notes app: server routes save notes and list them back.

## What it shows

- Server routes for creating and listing notes.
- A `notes` data collection that only server code can write.
- Activity logs you can read with `userland apps events`.

Anyone who can reach the app can add a note. Add sign-in before you use this pattern for private notes.

## Plan

**Plan needed: Free.** Nothing in this example needs a paid plan.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/server-notes
```

## Try it

```sh
curl -X POST https://<app-id>.apps.userland.fun/api/notes \
  -H 'content-type: application/json' \
  --data '{"title":"First note","body":"Hello"}'
curl https://<app-id>.apps.userland.fun/api/notes
```

## Troubleshoot or undo

```sh
userland apps events <app-id> --limit 25
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
```

Relevant skills:

- `.agents/skills/userland-runtime-code`
- `.agents/skills/userland-publish-operate`

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

- Server app quickstart: https://docs.userland.fun/quickstarts/server-app
- Data: https://docs.userland.fun/guides/data

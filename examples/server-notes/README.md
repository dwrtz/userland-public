# Server Notes

A small notes app: server routes save notes and list them back.

## What it shows

- A page with a note form and a list of notes, 20 at a time with a "Show more" button.
- Server routes for creating and listing notes.
- A `notes` data collection that only server code can write.
- Activity logs you can read with `userland apps events`.

Anyone who can reach the app can add a note. Add sign-in before you use this pattern for private notes.

Because anyone can post, the app protects its data quota (1,000 rows on Free):

- Titles are up to 200 characters and notes up to 2,000.
- The whole app takes at most 30 new notes an hour (`429` after that) and keeps at most 300 notes (`503 board_full`). Apps can't see visitors' IP addresses, so these limits are app-wide, not per person.
- Notes older than 30 days are deleted, up to 10 each time someone adds a note, to make room.
- A hidden form field catches simple bots; their posts are dropped.
- Notes can only be added from the app's own page, not from other sites.

There is no way to delete a single note in this example. To moderate notes, add sign-in with an owner role and a delete route.

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

Open `https://<app-id>.apps.userland.fun/` and add a note, or use curl:

```sh
curl -X POST https://<app-id>.apps.userland.fun/api/notes \
  -H 'content-type: application/json' \
  --data '{"title":"First note","body":"Hello"}'
curl https://<app-id>.apps.userland.fun/api/notes
```

The list returns up to 20 notes and, when there are more, a `cursor`. Pass it back as `?cursor=<cursor>` for the next page.

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

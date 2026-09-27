# Blog CMS

A blog where admins write posts and upload images, and anyone can read published posts.

## What it shows

- Server routes for the post list, post pages, and admin actions.
- App sign-in with an `admin` role. Only admins can create, publish, or upload.
- A `posts` data collection. Visitors only ever see published posts.
- A public `media` file store for images (up to 5 MB each).

## Plan

**Plan needed: Free.** Nothing in this example needs a paid plan.

It sits close to the Free plan's limits. Allowing uploads larger than 5 MB, adding open sign-up for readers, or adding a second file store needs a paid plan. Run `userland accounts limits` to see your account's current limits.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/blog-cms
```

## Add an admin

Sign-up is closed, so invite the first admin after publishing. The invite creates an app user for this blog only. It does not give access to your Userland account. See the Auth guide for the `POST /v0/apps/<app-id>/admin-invites` request.

## Try it

```sh
curl https://<app-id>.apps.userland.fun/api/posts
```

Creating a post without signing in as an admin returns `401`. Signing in without the `admin` role returns `403`.

## Troubleshoot or undo

```sh
userland apps events <app-id> --severity error --limit 25
userland apps releases <app-id>
userland apps rollback <app-id> <release-id>
```

Rollback changes which release is live. Posts, app users, and uploaded files are kept.

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

- Auth: https://docs.userland.fun/guides/auth
- Data: https://docs.userland.fun/guides/data
- Files: https://docs.userland.fun/guides/files
- Rollback: https://docs.userland.fun/guides/rollback

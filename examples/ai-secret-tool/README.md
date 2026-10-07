# AI Secret Tool

Call an AI model provider from the server so the provider key never reaches the browser.

The example uses a stand-in model call that spends nothing. Replace `callMockModel` in `server/index.js` with your provider's API.

**Before you connect a real provider key:** `/api/run` does not require sign-in. Anyone who finds the app's URL can call it, and every call would spend your provider credit. Add app sign-in and a daily limit per person in the same change; `AGENT.md` step 2 has the manifest and code. Invite-only sign-in and one small data collection both fit the Free plan; see the Auth guide.

## What it shows

- A page with a question box that calls the app's own server.
- One server route, `/api/run`, that takes a prompt and returns an answer of at most 4,000 characters.
- A `MODEL_API_KEY` secret that only server code can read. It is never sent to the browser, returned, or logged.
- Provider errors are logged by status and code only. Visitors get a plain `model_unavailable` error, never the provider's message, which can quote part of the key or your billing state.
- `/api/run` only accepts JSON from the app's own page. Another site, including another app on `userland.link`, gets a `403`, and plain form posts get a `415`.

## Plan

**Plan needed: Free.** Nothing in this example needs a paid plan. The Free plan allows one required secret; a second secret needs Starter or higher.

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/ai-secret-tool
```

The first publish creates the app and prints its app id. That release is not live yet: its activation status is `pending_secrets` because the secret is missing. Setting a secret does not activate a stored release, so set it and then publish again into the same app:

```sh
printf '%s' "$MODEL_API_KEY" | userland apps secrets set <app-id> MODEL_API_KEY
userland apps publish examples/ai-secret-tool --app <app-id>
```

You can add the key in the console instead: open `https://console.userland.fun/apps/<app-id>/settings?add-key=MODEL_API_KEY`, paste the key, and save it, then publish again with `--app` as above. A coding agent setting up the app for you sends you this link rather than asking you to paste the key into your chat.

Always pass `--app <app-id>` when publishing again. Without it, the CLI creates a second app.

## Try it

```sh
curl -X POST https://<app-id>.userland.link/api/run \
  -H 'content-type: application/json' \
  --data '{"prompt":"Summarize this"}'
```

## Troubleshoot or undo

```sh
userland apps events <app-id> --severity error --limit 25
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

- Secrets: https://docs.userland.fun/guides/secrets
- Auth: https://docs.userland.fun/guides/auth

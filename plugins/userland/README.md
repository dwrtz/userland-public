# Userland plugin

Build, publish and run apps for your business on [Userland](https://userland.fun/), from Claude Code or Codex. Describe what you need, such as a booking page, a client portal or an invoice tool, and your coding agent builds the app, checks it and publishes it at its own web address.

## What's in it

- **The Userland connector**, at `https://mcp.userland.fun/mcp`. It gives your agent Userland's tools: publish an app, read its errors and visits, undo a change, add a custom domain, and the rest. Each tool does the same thing as a command of the [Userland CLI](https://docs.userland.fun/reference/cli/), with the same checks and plan limits ([the full list](https://docs.userland.fun/reference/mcp/)).
- **Seven skills**, which tell your agent how to do each job well:
  - `userland-build-app`: from an idea to a published app.
  - `userland-adapt-examples`: start from one of the [public examples](https://github.com/dwrtz/userland-public/tree/main/examples).
  - `userland-manifest-resources`: sign-in, saved data, uploads, secret keys, scheduled tasks and webhooks.
  - `userland-runtime-code`: the app's server code.
  - `userland-publish-operate`: publish, secret keys, events, undo, invites, addresses, and copies of an app's files or data.
  - `userland-debug-migrate`: an app that isn't live, shows errors, or broke after a change.
  - `userland-account`: sign-in, businesses, plans and limits, API keys, and support.

The skills work without the connector too: in a coding agent with a terminal and no connector, they use the Userland CLI instead.

## Install

**Claude Code:**

```text
/plugin marketplace add dwrtz/userland-public
/plugin install userland@userland
```

Then run `/mcp`, choose `userland`, and sign in. Your browser opens Userland, where you sign in or sign up and approve the connection.

**Codex:**

```sh
codex plugin marketplace add dwrtz/userland-public
codex plugin add userland@userland
```

Codex asks you to sign in to Userland when you install it, in your browser.

**ChatGPT or Claude in your browser:** add Userland as a connector instead. See [Use Userland from ChatGPT or Claude](https://docs.userland.fun/guides/chat-assistants/).

## Use it

Ask for what you need in plain words, for example: "Build a booking page for my dog-grooming business, where customers pick a time and I see every booking." Your agent plans the app, builds it, checks it, and publishes it, then tells you its address. Later, ask it to change the app: Userland keeps earlier versions, so a change can be undone.

When the app needs a secret key, such as a payment or AI provider key, the agent gives you a Userland link where you type it yourself. Never paste a key into the chat.

## What it sends

- The skills are instructions for your agent. They send nothing, and the plugin has no scripts, hooks or programs of its own.
- When you connect, you sign in to Userland in your browser and approve the connection there. Your agent never sees your password.
- After that, your agent sends Userland the requests it makes through the connector: the files of the apps it publishes, and the details each tool needs, such as an app's id, a short address or an email address to invite. Userland handles them as its [Privacy Policy](https://userland.fun/legal/privacy/) describes.
- What the tools return, such as an app's status, events and visits, goes to your agent and to the company that runs it (Anthropic or OpenAI), under that company's terms.
- Secret values and new API keys are never sent through the chat: you type a secret on a Userland page, and a new key is shown on a Userland page once.
- To disconnect, sign out with your agent, or use the Chat assistants and Coding agents pages in the [Userland console](https://console.userland.fun/).

## Support and license

Questions or problems: support@userland.fun, or see [Getting help](https://docs.userland.fun/guides/getting-help/).

The skills in `skills/` are generated from [`.agents/skills`](https://github.com/dwrtz/userland-public/tree/main/.agents/skills) by `npm run plugin:build`; change them there.

MIT license. See [LICENSE](LICENSE).

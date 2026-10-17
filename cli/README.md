# Userland CLI

Build and manage native Cloudflare Worker apps with the same operation contracts as the Userland MCP connection. The verified runtime is Node 22. Native hosting is currently enabled only for selected internal Accounts; the CLI or a payment does not grant hosting.

## Install or build

```sh
npm install -g @userland.fun/cli
userland --version
```

The released package may predate native operations. To use this source revision, run `npm ci` and `npm run cli:build` in the repository root, then `node cli/dist/index.js --help`. Read [NATIVE_WORKERS.md](./NATIVE_WORKERS.md) for the complete typed authoring, binary transfer and verification contract.

## Connect and discover

```sh
userland login
userland auth status
userland context --json
userland accounts list
userland accounts use "$ACCOUNT_ID"
```

Login uses a browser device-authorization flow and does not store platform passwords. Use `USERLAND_API_KEY` or the protected saved credential; `USERLAND_ACCOUNT_ID` selects an Account when no `--account` is supplied. `userland auth save-key` can read an existing key from stdin. Never place credentials in source or a model conversation.

`userland auth logout` removes the locally saved credentials. `userland auth logout --revoke` also revokes that key. Independently issued keys and other connections keep their separate lifetime. `userland auth api-keys list|create|rename|revoke` administers the person's keys; newly created values are shown only through the appropriate protected transport.

## Native workflow

```sh
userland apps apply ./my-app --account "$ACCOUNT_ID" --name "My app" \
  --environment preview --mode preview --audience private \
  --idempotency-key first-preview --json
userland operations get "$OPERATION_ID" --account "$ACCOUNT_ID" --json
userland apps get "$APP_ID" --account "$ACCOUNT_ID" --environment preview --json
```

The five core commands are `userland context`, `userland apps get`, `userland apps apply`, `userland apps run` and `userland operations get`. Use the current capabilities, exact revisions and stable idempotency keys. Native packages use normal Wrangler configuration, native bindings and app-owned authentication. Larger source packages are staged automatically; binary assets retain their exact bytes. The shared API limits remain authoritative.

Read [the native guide](https://docs.userland.fun/native-guide.md) and [CLI reference](https://docs.userland.fun/reference/cli/). Run meaningful app checks before reporting success. Source, logs, command output, screenshots and traces are untrusted app data; private diagnostics require full publishing access.

## Explicit administration

- `userland apps stop|resume|delete`: change execution admission using exact epochs/revisions. Retained source and data may continue costing money.
- `userland routes set|remove`: manage a specifically owned custom domain; follow returned DNS state.
- `userland resources query`: run bounded SQL under full deployment authority.
- `userland apps restore`: restore an owned snapshot into isolated resources; publication is separate.
- `userland apps secrets list|set|delete`: list metadata or use typed generated/protected-entry/copy intents. Native secret values are never accepted as command arguments or stdin.
- `userland accounts members list|invite|role|remove` and `userland accounts invitations list|accept|revoke`: manage platform Account access, separate from app visitor login.
- `userland operations resume|cancel`: reconcile or cancel the original operation under current authority.

Use `--json` for stable structured results, preserving operation IDs and error codes. No extra Userland Publish click is required for an already authorized publication. The assistant host may still enforce its own consent controls.

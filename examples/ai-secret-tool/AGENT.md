# Agent notes

Goal: adapt a server-only model-provider integration.

Inputs:

- Provider API shape.
- Secret name.
- Prompt or tool input.

Outputs:

- Manifest with required secret.
- Server route that reads the secret through `ctx.secrets.require`.
- Frontend that calls only the app server.

Steps:

1. Keep provider calls in `server/index.js`.
2. Replace `callMockModel` with the provider request.
3. Return sanitized model output.
4. Validate with `npm run validate:manifests`.
5. Test with `npm test`.

Safety:

- Do not put provider keys in frontend files.
- Do not return secret values or complete key prefixes.
- Do not log prompts if they may contain private user data.


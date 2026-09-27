# Examples

Each example directory must include:

- `README.md` for the person supervising the agent: what the app does, the plan it needs, and how to publish it.
- `AGENT.md` for coding agents: plan details, adaptation steps, validation commands, and safety rules.
- `example.json` metadata. It must match the example's `catalog.json` entry exactly.
- `manifest.userland.json`. It must validate against `schemas/resource-manifest-v0.schema.json`, which only allows `app`, `runtime`, and `resources` at the top level. Pass a release message with `userland apps publish <dir> --message "..."` instead of adding a `message` key.
- `public/` files when the app has static assets.
- `server/index.js` when the app has dynamic routes, jobs, webhooks, or resource access.
- `tests/*.test.ts` for server code (recommended). `scripts/runtime-harness.ts` builds a test `ctx` from the manifest and rejects calls the Userland runtime rejects, such as queries on unindexed fields or undeclared secrets.

Example metadata follows this shape:

```json
{
  "slug": "tiny-store",
  "title": "Tiny Store",
  "summary": "Small storefront with products, orders, checkout secrets, jobs, and webhooks.",
  "path": "examples/tiny-store",
  "capabilities": ["server", "auth", "data", "files", "secrets", "jobs", "webhooks", "rollback"],
  "difficulty": "advanced",
  "userland_api_version": "v0",
  "required_plan": "business",
  "paid_features": ["auth.public_signup", "jobs.schedule.allowed", "webhooks.enabled"],
  "launch_role": "capability-fixture"
}
```

(`paid_features` is shortened here; the real entry lists every key.)

Launch examples also set a live demo and a marketing page:

```json
{
  "launch_role": "launch-example",
  "demo_url": "https://<demo-slug>.apps.userland.fun/",
  "page_url": "https://userland.fun/examples/<slug>/"
}
```

## Plan metadata

- `required_plan` is the lowest plan that can publish the manifest: `free`, `starter`, `business`, `business_plus`, or `agency`.
- `paid_features` lists the manifest feature and limit keys that need more than the Free plan, using the same `feature_key` and `limit_key` names a publish `402` error reports. It is `[]` for Free examples.
- Both come from Userland's plan entitlement rules for the manifest, not from guesses. `npm run validate:catalog` recomputes them from each manifest (with the rules in `scripts/plan-entitlements.ts`) and fails on any mismatch, so update them whenever the manifest's resources change, and state the plan plainly in `README.md` and `AGENT.md`.
- `capabilities` must list every resource the manifest declares (`server`, `auth`, `data`, `files`, `secrets`, `jobs`, `webhooks`), and no resource it does not declare. `static` is listed only for examples with no server. `rollback` and `transactions` describe behavior and are not checked.
- `launch_role` is `launch-example` for the polished examples featured at launch, or `capability-fixture` for small examples that each show one platform capability.

## Current plans

| Example | Plan needed | Why |
| --- | --- | --- |
| `hello-static` | Free | Static files only. |
| `blog-cms` | Free | One admin role, one collection, one public file store, 5 MB uploads. |
| `server-notes` | Free | One collection. |
| `ai-secret-tool` | Free | One secret. |
| `booking-lite` | Free | Two collections. |
| `webhook-automation` | Starter | Webhooks are not on Free. |
| `tiny-store` | Business | Open customer sign-up and an hourly job. |

Validate one example while others are in progress:

```sh
npm run validate:manifests -- <slug>
npm run validate:links -- <slug>
npx vitest run examples/<slug>
```

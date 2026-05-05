# Agent notes

Goal: adapt a static-only Userland app.

Inputs:

- Static page content.
- Optional CSS and browser JavaScript.

Outputs:

- `manifest.userland.json`.
- Files under `public/`.

Steps:

1. Keep `runtime.static_root` set to `public`.
2. Add static assets under `public/`.
3. Do not add `server/index.js` unless the app needs dynamic routes or managed resources.
4. Validate with `npm run validate:manifests`.

Safety:

- Do not put `USERLAND_API_KEY` in static files.
- Do not put app secrets in static files.


# Hello Static

Small static Userland app with no server runtime or managed resources.

Use this example when the app only needs static HTML, CSS, JavaScript, and assets.

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/hello-static
```

Expected output includes `app_id`, `origin`, `release_id`, and activation status.


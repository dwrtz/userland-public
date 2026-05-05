# Server Notes

Dynamic notes app with server routes, `ctx.data`, and runtime logs.

Relevant skills:

- `.agents/skills/userland-runtime-code`
- `.agents/skills/userland-publish-operate`

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/server-notes
```

## Verify

```sh
curl <origin>/api/notes
```

Expected activation status is `live`.


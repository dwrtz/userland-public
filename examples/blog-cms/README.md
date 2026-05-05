# Blog CMS

Admin-authored blog with app users, durable post data, public post pages, and media uploads.

## Capabilities

- Server runtime routes.
- App-user auth with an `admin` role.
- Data collection named `posts`.
- Public file store named `media`.

## Publish

```sh
USERLAND_API_KEY=... npm run userland -- apps publish examples/blog-cms
```

After publishing, create or invite an admin user according to the auth docs before using protected write routes.


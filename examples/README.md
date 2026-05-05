# Examples

Each example directory must include:

- `README.md` for humans.
- `AGENT.md` for coding agents.
- `example.json` metadata.
- `manifest.userland.json`.
- `public/` files when the app has static assets.
- `server/index.js` when the app has dynamic routes, jobs, webhooks, or resource access.

Example metadata follows this shape:

```json
{
  "slug": "blog-cms",
  "title": "Blog CMS",
  "summary": "Admin-authored blog with posts and media uploads.",
  "path": "examples/blog-cms",
  "capabilities": ["auth", "data", "files", "server", "rollback"],
  "difficulty": "intermediate",
  "userland_api_version": "v0"
}
```


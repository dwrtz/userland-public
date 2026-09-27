# Link-in-Bio App

A link-in-bio page for a creator, with featured products, a list of links, an email-list signup, a contact form, and a private owner view where the owner reads messages, downloads the email list, and edits links.

The sample business is **Kiln & Crumb**, a made-up potter who sells pie dishes and mugs. Swap in your own name, colors, and links.

- Live demo: https://link-in-bio-demo.apps.userland.fun/
- Example page: https://userland.fun/examples/link-in-bio-app/
- Plan: runs on the **Free** plan. A custom domain (like `links.yourstudio.com`) needs Starter.

## What visitors see

- `/` shows the profile, social buttons, featured products with prices, the list of links, an email-list signup, and a contact card.
- `/contact` is a contact form with a topic picker.
- `/thanks` confirms a signup or message.
- `/go/:id` counts a tap, then sends the visitor to the link.

## What the owner sees

- `/admin` is the inbox: contact messages (new, replied, archived) and the email list, with a spreadsheet download for your newsletter tool.
- `/admin/links` adds, edits, hides, reorders, and deletes links, and shows tap counts. A link marked "featured" shows as a product card with a price.

The owner view is for app users with the `owner` role. Signed-out visitors are sent to the Userland sign-in page; signed-in users without the role get a "for the page owner" message.

## Files

```text
manifest.userland.json   app name, runtime, owner role, and the two data collections
public/                  styles, self-hosted fonts, pictures, favicon
server/index.js          routes, form checks, and the owner gate
server/content.js        name, bio, social profiles, form wording, starter links
server/views.js          HTML for every page (all output is escaped)
server/store.js          reads and writes for the links and inbox collections
server/demo.js           demo mode for the public demo only (safe to delete)
tests/                   vitest tests with an in-memory Userland ctx
```

## Make it yours

1. Edit `server/content.js`: brand, name, bio, social links, form wording, and starter links.
2. Change colors and fonts at the top of `public/assets/site.css` (the `:root` tokens and `@font-face` rules). Fonts are self-hosted; keep the license files in `public/fonts/` if you keep the fonts.
3. Swap the logo: the round avatar and small marks come from `logoMark()` in `server/views.js`. Replace its SVG with your own logo, or return an `<img src="/img/avatar.jpg" alt="">` and drop your photo into `public/img/`.
4. Add a picture for links by dropping an SVG into `public/img/` and adding its name to `pictures` in `server/content.js`.
5. Run the tests:

   ```sh
   npx vitest run examples/link-in-bio-app
   ```

## Publish

Install the CLI and sign in. `userland login` opens your browser to approve the CLI; it does not ask for or store a password.

```sh
npm install -g @userland.fun/cli
userland login
userland apps publish examples/link-in-bio-app --message "First release"
```

Note the `app_id` it prints. Later releases:

```sh
userland apps publish examples/link-in-bio-app --app "$APP_ID" --message "Update links page"
```

### Make yourself the owner

Invite your email with the `owner` role through the Userland API (the invite creates an app user for this app only). The invite is an API request, so it needs an API key in `USERLAND_API_KEY`. `userland login` keeps its key in `~/.userland/credentials.json`, not in your shell, so create a key for the invite (the CLI shows it once, under `API key:`) and put it and the app id in your environment. Run this in your own terminal; the key never goes into the app.

```sh
userland auth api-keys create --name "link-in-bio-app owner invite"
export USERLAND_API_KEY="<the key printed under API key:>"
export APP_ID="<the app_id from the publish output>"

curl -fsS -X POST \
  -H "authorization: Bearer $USERLAND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","roles":["owner"]}' \
  "https://api.userland.fun/v0/apps/$APP_ID/admin-invites"
```

Open the invite link, set a password, then visit `/admin`. After that, open **Links** and click **Add starter links** to fill the page from `server/content.js`, then edit them. Once the owner has signed in, run `unset USERLAND_API_KEY` (CLI commands use that variable before your saved login), then revoke the invite key with `userland auth api-keys revoke <api-key-id>` (the id is printed as `Created API key ...`).

### Undo a release

Publishing never deletes your links, messages, or signups. To go back to an earlier release:

```sh
userland apps releases "$APP_ID"
userland apps rollback "$APP_ID" "$RELEASE_ID"
```

## Demo mode

`server/demo.js` only switches on for `link-in-bio-demo.apps.userland.fun`, so your copy already requires sign-in for the owner view. On the demo host it:

- opens the owner view without sign-in,
- gives each visitor a private key in the page address (`?visit=...`) and their own copy of made-up messages, signups, and links, because Userland passes only its own sign-in cookie to app code,
- stores everything a visitor sends or changes under that key, so visitors never see each other's data,
- stores typed email addresses partly hidden (`a•••@r•••.com`; `@example.com` addresses are kept), because anyone handed a visitor's exact address can open that visitor's copy, and says so in the owner view along with the plain demo address to share,
- asks visitors to use made-up details on the public forms,
- shows a "where this link goes" page instead of leaving the demo,
- deletes copies older than six hours,
- adds `noindex` and a "Built with Userland" ribbon to every page.

To remove it, delete `server/demo.js`, then delete the `demoMode` import and every line that mentions `demo` in `server/index.js`. The `nav.demo` checks in `server/views.js` can stay (they are always off) or be deleted. The `demo_key` field can stay (it is always empty) or be removed from the manifest before your first publish.

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

- Auth: https://docs.userland.fun/guides/auth
- Data: https://docs.userland.fun/guides/data
- Rollback: https://docs.userland.fun/guides/rollback

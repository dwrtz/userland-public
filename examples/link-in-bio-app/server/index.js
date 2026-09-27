// Link-in-bio app for Userland.
//
// Public routes:  GET /  POST /subscribe  GET|POST /contact  GET /thanks  GET /go/:id
// Owner routes:   /admin/*  (app users with the "owner" role; see requireOwner)
//
// Static files (styles, fonts, pictures) are served by Userland from public/.
// Everything else falls through to this module because the manifest sets
// runtime.fallback to "server".
//
// Demo mode lives in demo.js. The lines in this file that turn it on end with
// `// demo`; deleting them and demo.js removes it (see "Demo mode" in README.md).

import { contact, pictures, profile } from "./content.js";
import { demoMode } from "./demo.js"; // demo
import {
  addSignup,
  addStarterLinks,
  createInboxItem,
  createLink,
  deleteLink,
  getInboxItem,
  getLink,
  listInbox,
  listLinks,
  moveLink,
  nextPosition,
  recordClick,
  setInboxStatus,
  updateLink
} from "./store.js";
import { PLAIN_NAV, contactPage, editLinkPage, homePage, inboxPage, linksPage, messagePage, thanksPage } from "./views.js";

export const OWNER_ROLE = "owner";
const MAX_BODY_BYTES = 16 * 1024;
// Deliberately conservative: letters, digits and . _ + ' - only. Characters
// like ? & = % # would let a sender add extra fields (cc, bcc, body) to the
// owner's "Reply" email link, so they are rejected here.
const EMAIL_PATTERN = /^[A-Za-z0-9._+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export default {
  async fetch(request, ctx) {
    // A HEAD from a link checker or uptime monitor isn't a visitor: it doesn't
    // count as a tap on /go/:id, and in the demo it doesn't set up sample data.
    if (request.method === "HEAD") return await answerHead(request, ctx, (get) => route(get, ctx, { head: true }));
    return await route(request, ctx);
  }
};

async function route(request, ctx, { head = false } = {}) {
  const url = new URL(request.url);
  let demo = null; // The public demo's visitor state. Always null in your own app.
  demo = demoMode(request); // demo
  const nav = demo ? demoNav(demo, "noindex,follow") : PLAIN_NAV;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  try {
    if (path === "/" && method === "GET") return await showHome(ctx, nav, demo);
    if (path === "/subscribe" && method === "POST") return await subscribe(request, ctx, nav, demo);
    if (path === "/contact" && method === "GET") return html(contactPage({ nav, values: { topic: contact.topics[0] } }));
    if (path === "/contact" && method === "POST") return await sendMessage(request, ctx, nav, demo);
    if (path === "/thanks" && method === "GET") return html(thanksPage({ nav, kind: url.searchParams.get("kind") }));
    if (path.startsWith("/go/") && method === "GET") return await followLink(ctx, nav, demo, path.slice(4), { countClick: !head });
    if (path === "/admin" || path.startsWith("/admin/")) return await ownerRoutes(request, ctx, url, path, method, demo, { head });
    return notFound(nav);
  } catch (error) {
    await ctx.log.error("request failed", { path, message: error instanceof Error ? error.message : String(error) });
    return html(messagePage({ nav, title: "Something went wrong", heading: "Something went wrong", body: "Please try again in a moment.", action: { href: nav.href("/"), label: "Back to the page" } }), 500);
  }
}

// ---------------------------------------------------------------- public

async function showHome(ctx, nav, demo) {
  const links = demo ? await demo.publicLinks(ctx) : await listLinks(ctx, "");
  return html(homePage({ nav, links }));
}

async function subscribe(request, ctx, nav, demo) {
  const form = await readForm(request);
  if (!form) return tooLarge(nav);
  demo?.useKeyFrom(form.get("visit"));
  if (isBot(form)) return redirect(nav.href("/thanks?kind=signup"));

  const values = { name: clean(form.get("name"), 80), email: clean(form.get("email"), 254) };
  const errors = {};
  if (!EMAIL_PATTERN.test(values.email)) errors.email = "Please enter an email address like name@example.com.";
  if (Object.keys(errors).length) {
    const links = demo ? await demo.publicLinks(ctx) : await listLinks(ctx, "");
    return html(homePage({ nav, links, signupForm: values, signupErrors: errors }), 422);
  }

  if (demo) {
    await demo.ensureVisitor(ctx);
    if (await demo.isFull(ctx, "inbox")) return demoFull(nav);
  }
  await addSignup(ctx, demo?.scope ?? "", demo ? demo.privateDetails(values) : values);
  await ctx.log.info("email signup", {});
  return redirect(nav.href("/thanks?kind=signup"));
}

async function sendMessage(request, ctx, nav, demo) {
  const form = await readForm(request);
  if (!form) return tooLarge(nav);
  demo?.useKeyFrom(form.get("visit"));
  if (isBot(form)) return redirect(nav.href("/thanks?kind=message"));

  const values = {
    name: clean(form.get("name"), 80),
    email: clean(form.get("email"), 254),
    topic: clean(form.get("topic"), 40),
    message: clean(form.get("message"), 2000, { multiline: true })
  };
  const errors = {};
  if (!values.name) errors.name = "Please tell me your name.";
  if (!EMAIL_PATTERN.test(values.email)) errors.email = "Please enter an email address like name@example.com.";
  if (!contact.topics.includes(values.topic)) errors.topic = "Please pick a topic.";
  if (values.message.length < 2) errors.message = "Please write a short message.";
  if (String(form.get("message") ?? "").length > 2000) errors.message = "Please keep your message under 2,000 characters.";
  if (Object.keys(errors).length) return html(contactPage({ nav, values, errors }), 422);

  if (demo) {
    await demo.ensureVisitor(ctx);
    if (await demo.isFull(ctx, "inbox")) return demoFull(nav);
  }
  await createInboxItem(ctx, demo?.scope ?? "", { kind: "message", ...(demo ? demo.privateDetails(values) : values) });
  await ctx.log.info("contact message", { topic: values.topic });
  return redirect(nav.href("/thanks?kind=message"));
}

// Link buttons point here so the owner can see tap counts.
async function followLink(ctx, nav, demo, rawId, { countClick = true } = {}) {
  const id = decodePart(rawId);
  if (id === null) return notFound(nav);
  const back = nav.href("/");
  if (demo && id.startsWith("social/")) {
    const target = demo.socialTarget(id.slice("social/".length));
    return target ? html(demo.interstitial(target, back)) : notFound(nav);
  }
  const link = await getLink(ctx, demo?.scope ?? "", id);
  if (!link || link.visible === false) return notFound(nav);
  if (countClick) await recordClick(ctx, link);
  if (demo) return html(demo.interstitial(link.url, back));
  return new Response(null, { status: 302, headers: { location: link.url, "cache-control": "no-store" } });
}

// ---------------------------------------------------------------- owner

async function ownerRoutes(request, ctx, url, path, method, demo, { head = false } = {}) {
  let nav;
  if (demo) {
    // The public demo skips sign-in. Each visitor gets their own copy of the
    // sample data instead (see server/demo.js).
    const form = method === "POST" ? await readForm(request.clone()) : null;
    demo.useKeyFrom(form?.get("visit"));
    // A HEAD gets the same redirect to a new key, but no copy of the sample data.
    if (await demo.ensureVisitor(ctx, { seed: !head })) return redirect(demo.href(url.pathname + url.search));
    nav = demoNav(demo, "noindex,follow", { owner: true });
  } else {
    const denied = await requireOwner(request, ctx, url, method);
    if (denied) return denied;
    nav = PLAIN_NAV;
  }
  const scope = demo?.scope ?? "";

  if (path === "/admin" && method === "GET") {
    const tab = ["messages", "list", "archived"].includes(url.searchParams.get("tab")) ? url.searchParams.get("tab") : "messages";
    const [messages, signups] = await Promise.all([listInbox(ctx, scope, "message"), listInbox(ctx, scope, "signup")]);
    return html(inboxPage({ nav, tab, messages, signups, flash: flashText(url) }));
  }

  if (path === "/admin/email-list.csv" && method === "GET") {
    const signups = (await listInbox(ctx, scope, "signup")).filter((row) => row.status !== "archived");
    return new Response(toCsv(signups), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="email-list.csv"',
        "cache-control": "no-store"
      }
    });
  }

  const inboxMatch = /^\/admin\/inbox\/([^/]+)$/.exec(path);
  if (inboxMatch && method === "POST") {
    const form = await readForm(request);
    const id = decodePart(inboxMatch[1]);
    const item = id === null ? null : await getInboxItem(ctx, scope, id);
    const status = String(form?.get("status") ?? "");
    if (!item || !["new", "replied", "archived"].includes(status)) return notFound(nav);
    await setInboxStatus(ctx, item.id, status);
    const tab = item.kind === "signup" ? "list" : "messages";
    return redirect(nav.href(`/admin?tab=${tab}&done=${status}`));
  }

  if (path === "/admin/links" && method === "GET") {
    return html(linksPage({ nav, links: await listLinks(ctx, scope), flash: flashText(url) }));
  }

  if (path === "/admin/links" && method === "POST") {
    const form = await readForm(request);
    if (!form) return tooLarge(nav);
    const { values, errors } = readLinkForm(form);
    const links = await listLinks(ctx, scope);
    if (Object.keys(errors).length) return html(linksPage({ nav, links, values, errors }), 422);
    if (demo && (await demo.isFull(ctx, "links"))) return demoFull(nav);
    await createLink(ctx, scope, values, nextPosition(links));
    return redirect(nav.href("/admin/links?done=added"));
  }

  if (path === "/admin/links/starter" && method === "POST") {
    await addStarterLinks(ctx, scope);
    return redirect(nav.href("/admin/links?done=added"));
  }

  const linkMatch = /^\/admin\/links\/([^/]+)$/.exec(path);
  if (linkMatch) {
    const id = decodePart(linkMatch[1]);
    const link = id === null ? null : await getLink(ctx, scope, id);
    if (!link) return notFound(nav);
    if (method === "GET") return html(editLinkPage({ nav, link }));
    if (method !== "POST") return notFound(nav);

    const form = await readForm(request);
    if (!form) return tooLarge(nav);
    const action = String(form.get("action") ?? "");
    if (action === "up" || action === "down") {
      await moveLink(ctx, scope, link.id, action === "up" ? -1 : 1);
      return redirect(nav.href("/admin/links"));
    }
    if (action === "hide" || action === "show") {
      await updateLink(ctx, link.id, { visible: action === "show" });
      return redirect(nav.href(`/admin/links?done=${action === "show" ? "shown" : "hidden"}`));
    }
    if (action === "delete") {
      await deleteLink(ctx, link.id);
      return redirect(nav.href("/admin/links?done=deleted"));
    }
    if (action === "save") {
      const { values, errors } = readLinkForm(form);
      if (Object.keys(errors).length) return html(editLinkPage({ nav, link, values, errors }), 422);
      await updateLink(ctx, link.id, values);
      return redirect(nav.href("/admin/links?done=saved"));
    }
    return notFound(nav);
  }

  return notFound(nav);
}

// The owner gate. Owners are app users with the "owner" role, invited through
// the Userland API (see README.md). Sign-in pages live at /_userland/auth/*.
async function requireOwner(request, ctx, url, method) {
  const user = await ctx.auth.currentUser(request);
  if (!user) {
    if (method !== "GET") return new Response("Sign in required.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
    const returnTo = url.pathname + url.search;
    return redirect(`/_userland/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  }
  try {
    await ctx.auth.requireRole(request, OWNER_ROLE);
  } catch {
    return html(
      messagePage({
        nav: PLAIN_NAV,
        title: "Owners only",
        heading: "This part is for the page owner",
        body: `You're signed in as ${user.email}, but this account can't manage ${profile.brand}.`,
        action: { href: "/_userland/auth/logout?return_to=%2F", label: "Sign out" }
      }),
      403
    );
  }
  // Session cookies are SameSite=Lax, which already blocks cross-site form
  // posts. Checking Origin as well keeps owner changes same-site only.
  const origin = request.headers.get("origin");
  if (method !== "GET" && origin && origin !== url.origin) {
    return new Response("Cross-site request refused.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return null;
}

function readLinkForm(form) {
  const values = {
    title: clean(form.get("title"), 80),
    url: clean(form.get("url"), 500),
    note: clean(form.get("note"), 140),
    price: clean(form.get("price"), 20),
    picture: clean(form.get("picture"), 40),
    featured: form.get("featured") === "yes",
    visible: form.get("visible") === "yes"
  };
  const errors = {};
  if (!values.title) errors.title = "Give the link a title.";
  if (!isWebAddress(values.url)) errors.url = "Use a full web address that starts with https://";
  if (!pictures.some((p) => p.value === values.picture)) values.picture = "plate";
  return { values, errors };
}

// ---------------------------------------------------------------- helpers

// Page helpers for the demo. Getters read the visitor key at render time,
// because a key can be created partway through a request.
function demoNav(demo, robots, { owner = false } = {}) {
  return {
    href: (path) => demo.href(path),
    get hidden() {
      return demo.hiddenField();
    },
    get ribbon() {
      return demo.ribbon({ owner });
    },
    robots,
    demo
  };
}

async function readForm(request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return null;
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) return new FormData();
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  const form = new FormData();
  for (const [key, value] of new URLSearchParams(text)) form.append(key, value);
  return form;
}

// Decodes one address segment. Broken escapes like %E0%A4 mean "not found",
// not a server error.
function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// Trims, removes control characters, and caps the length of a form value.
function clean(value, max, { multiline = false } = {}) {
  let text = typeof value === "string" ? value : "";
  text = multiline ? text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ") : text.replace(/\s+/g, " ");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  return text.slice(0, max);
}

// The hidden "website" field is empty for people and filled in by many bots.
function isBot(form) {
  return String(form.get("website") ?? "").trim() !== "";
}

function isWebAddress(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

// Spreadsheet apps treat cells that start with = + - @ as formulas, so those
// get a leading apostrophe.
export function toCsv(rows) {
  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines = [["email", "name", "joined"].map(cell).join(",")];
  for (const row of rows) lines.push([row.email, row.name, row.received_at].map(cell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

function flashText(url) {
  const done = url.searchParams.get("done");
  return (
    {
      replied: "Marked as replied.",
      new: "Moved back to new.",
      archived: "Archived.",
      added: "Link added to your page.",
      saved: "Changes saved.",
      shown: "Link is showing on your page.",
      hidden: "Link is hidden from your page.",
      deleted: "Link deleted."
    }[done] ?? null
  );
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cache-control": "no-store"
};

function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function notFound(nav) {
  return html(messagePage({ nav, title: "Not found", heading: "That page isn't here", body: "The link may be old, or the page may have moved.", action: { href: nav.href("/"), label: `Back to ${profile.brand}` } }), 404);
}

function tooLarge(nav) {
  return html(messagePage({ nav, title: "Too long", heading: "That was a bit long", body: "Please shorten your message and try again.", action: { href: nav.href("/"), label: "Back to the page" } }), 413);
}

function demoFull(nav) {
  return html(messagePage({ nav, title: "Demo is full", heading: "That's plenty for a demo", body: "You've added a lot here already. Open the page in a new private window to start over.", action: { href: nav.href("/admin"), label: "Open the owner view" } }), 429);
}

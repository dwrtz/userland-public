// HTML for every page. Pages are rendered on the server and work without
// JavaScript. Every value that came from a visitor or the database goes
// through escapeHtml() before it reaches the page.

import { contact, emailList, pictures, profile, socials } from "./content.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const e = escapeHtml;

// `nav` carries per-request helpers. A normal app uses PLAIN_NAV; the demo
// swaps in helpers that keep the visitor's key in links and forms.
export const PLAIN_NAV = { href: (path) => path, hidden: "", ribbon: "", robots: null, demo: null };

// ---------------------------------------------------------------- layout

export function layout({ title, description = "", robots = null, ribbon = "", bodyClass = "", main }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
${description ? `<meta name="description" content="${e(description)}">\n<meta property="og:title" content="${e(title)}">\n<meta property="og:description" content="${e(description)}">\n<meta property="og:type" content="website">` : ""}
${robots ? `<meta name="robots" content="${e(robots)}">` : ""}
<meta name="theme-color" content="#FFF1DC">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/shrikhand-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/nunito-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body class="${e(bodyClass)}">
<a class="skip-link" href="#main">Skip to content</a>
${ribbon}
<main id="main">
${main}
</main>
</body>
</html>`;
}

export function logoMark(size = 48, extraClass = "") {
  return `<svg class="logo-mark ${extraClass}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <circle cx="32" cy="32" r="31" fill="#2B45D8"/>
  <circle cx="32" cy="32" r="24" fill="#FFF1DC"/>
  <path d="M32 33 L47.97 27.19 A17 17 0 1 1 34.95 16.26 Z" fill="#FFD84D" stroke="#E0A21B" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M23.5 36.5 L20.5 39.5 M31 41.5 L31 46 M39 37.5 L42 40.5 M25 27 L22 25" stroke="#E0A21B" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M36.4 27.9 L39.35 11.16 A17 17 0 0 1 52.37 22.09 Z" fill="#F2542D"/>
  <path d="M36.4 27.9 L39.35 11.16 A17 17 0 0 1 52.37 22.09 Z" fill="none" stroke="#FFD84D" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M39.35 11.16 A17 17 0 0 1 52.37 22.09" fill="none" stroke="#E0A21B" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="9" cy="40" r="1.6" fill="#FFF1DC"/><circle cx="14" cy="52" r="1.3" fill="#FFF1DC"/><circle cx="50" cy="55" r="1.6" fill="#FFF1DC"/>
</svg>`;
}

function picture(name, className, size) {
  const known = pictures.some((item) => item.value === name) ? name : "plate";
  return `<img class="${className}" src="/img/${known}.svg" alt="" width="${size[0]}" height="${size[1]}" loading="lazy" decoding="async">`;
}

const SOCIAL_ICONS = {
  instagram: `<rect x="4" y="4" width="16" height="16" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.9" cy="7.1" r="1.2" fill="currentColor"/>`,
  tiktok: `<path d="M14 4v10.2a3.8 3.8 0 1 1-3.8-3.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M14 4c.4 2.6 2.2 4.3 5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
  youtube: `<rect x="3" y="6" width="18" height="12" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 9.5v5l4.3-2.5z" fill="currentColor"/>`,
  pinterest: `<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 20l1.6-7.4m-1.3-.1c.4-1.7 1.6-2.6 2.9-2.3 1.6.4 1.7 2.6.6 4.1-.9 1.2-2.5 1.3-3.4.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`
};

function socialIcon(name) {
  return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SOCIAL_ICONS[name] ?? SOCIAL_ICONS.instagram}</svg>`;
}

const ARROW = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h13m-5-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------- public page

export function homePage({ nav, links, signupForm = {}, signupErrors = {} }) {
  const visible = links.filter((link) => link.visible !== false);
  const featured = visible.filter((link) => link.featured);
  const regular = visible.filter((link) => !link.featured);
  const outbound = (link) => nav.href(`/go/${encodeURIComponent(link.id)}`);
  const socialHref = (social) => (nav.demo ? nav.href(`/go/social/${social.icon}`) : social.url);

  const featuredHtml = featured.length
    ? `<section class="featured" aria-labelledby="featured-title">
  <h2 id="featured-title" class="section-title">Fresh from the kiln</h2>
  <ul class="product-grid" role="list">
${featured
  .map(
    (link) => `    <li class="product">
      <a class="product-link" href="${e(outbound(link))}">
        <span class="product-picture">${picture(link.picture, "product-img", [320, 240])}</span>
        <span class="product-body">
          <span class="product-title">${e(link.title)}</span>
          ${link.note ? `<span class="product-note">${e(link.note)}</span>` : ""}
          <span class="product-foot">${link.price ? `<span class="price">${e(link.price)}</span>` : ""}<span class="product-cta">Shop ${ARROW}</span></span>
        </span>
      </a>
    </li>`
  )
  .join("\n")}
  </ul>
</section>`
    : "";

  const linksHtml = regular.length
    ? `<section class="links" aria-labelledby="links-title">
  <h2 id="links-title" class="section-title">More from the studio</h2>
  <ul class="link-list" role="list">
${regular
  .map(
    (link) => `    <li><a class="link-pill" href="${e(outbound(link))}">
      <span class="link-thumb">${picture(link.picture, "thumb-img", [56, 56])}</span>
      <span class="link-text"><span class="link-title">${e(link.title)}</span>${link.note ? `<span class="link-note">${e(link.note)}</span>` : ""}</span>
      <span class="link-arrow">${ARROW}</span>
    </a></li>`
  )
  .join("\n")}
  </ul>
</section>`
    : "";

  const main = `<div class="home">
  <div class="home-side">
    <section class="profile card" aria-labelledby="brand-name">
      <div class="avatar">${logoMark(104)}</div>
      <h1 id="brand-name" class="brand">${e(profile.brand)}</h1>
      <p class="byline"><strong>${e(profile.person)}</strong> <span aria-hidden="true">&middot;</span> ${e(profile.role)}</p>
      <p class="bio">${e(profile.bio)}</p>
      <ul class="socials" role="list">
${socials.map((social) => `        <li><a class="social" href="${e(socialHref(social))}" aria-label="${e(profile.brand)} on ${e(social.label)}">${socialIcon(social.icon)}</a></li>`).join("\n")}
      </ul>
    </section>
    ${signupCard({ nav, values: signupForm, errors: signupErrors })}
  </div>
  <div class="home-main">
    ${featuredHtml}
    ${linksHtml}
    <section class="contact-card card" aria-labelledby="contact-title">
      <h2 id="contact-title" class="contact-title">${e(contact.heading)}</h2>
      <p>${e(contact.body)}</p>
      <a class="button button-butter" href="${e(nav.href("/contact"))}">${e(contact.button)} ${ARROW}</a>
    </section>
  </div>
</div>
<footer class="site-footer">
  <p>${logoMark(28)} <span>Made by hand in a very small garage.</span></p>
</footer>`;

  return layout({
    title: profile.pageTitle,
    description: profile.pageDescription,
    robots: nav.robots,
    ribbon: nav.ribbon,
    bodyClass: "page-home",
    main
  });
}

function signupCard({ nav, values, errors }) {
  const errorSummary = Object.keys(errors).length ? `<p class="form-error" role="alert">${e(Object.values(errors)[0])}</p>` : "";
  return `<section class="signup card" id="email-list" aria-labelledby="signup-title">
      <h2 id="signup-title" class="signup-title">${e(emailList.heading)}</h2>
      <p>${e(emailList.body)}</p>
      ${nav.demo ? nav.demo.formHint() : ""}
      <form class="stack" method="post" action="/subscribe" novalidate>
        ${nav.hidden}
        ${errorSummary}
        <div class="field">
          <label for="signup-name">First name <span class="optional">(optional)</span></label>
          <input id="signup-name" name="name" type="text" autocomplete="given-name" maxlength="80" value="${e(values.name)}">
        </div>
        <div class="field">
          <label for="signup-email">Email</label>
          <input id="signup-email" name="email" type="email" autocomplete="email" required maxlength="254" value="${e(values.email)}"${errors.email ? ' aria-invalid="true" aria-describedby="signup-email-error"' : ""}>
          ${errors.email ? `<p class="field-error" id="signup-email-error">${e(errors.email)}</p>` : ""}
        </div>
        ${honeypot("signup")}
        <button class="button" type="submit">${e(emailList.button)}</button>
      </form>
    </section>`;
}

// A field real people never see or fill in. Bots that fill every field are
// quietly ignored by the server.
function honeypot(prefix) {
  return `<div class="hp" aria-hidden="true"><label for="${prefix}-website">Leave this empty</label><input id="${prefix}-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>`;
}

// ---------------------------------------------------------------- contact

export function contactPage({ nav, values = {}, errors = {} }) {
  const field = (name) => (errors[name] ? ` aria-invalid="true" aria-describedby="contact-${name}-error"` : "");
  const error = (name) => (errors[name] ? `<p class="field-error" id="contact-${name}-error">${e(errors[name])}</p>` : "");
  const main = `<div class="narrow">
  <p class="back"><a href="${e(nav.href("/"))}"><span aria-hidden="true">&larr;</span> Back to ${e(profile.brand)}</a></p>
  <section class="card form-card" aria-labelledby="contact-page-title">
    <div class="form-card-head">${logoMark(56)}<h1 id="contact-page-title" class="page-title">Send ${e(profile.person.split(" ")[0])} a note</h1></div>
    <p>${e(contact.body)}</p>
    ${nav.demo ? nav.demo.formHint() : ""}
    <form class="stack" method="post" action="/contact" novalidate>
      ${nav.hidden}
      ${Object.keys(errors).length ? `<p class="form-error" role="alert">Please fix the highlighted fields.</p>` : ""}
      <div class="field-row">
        <div class="field">
          <label for="contact-name">Your name</label>
          <input id="contact-name" name="name" type="text" autocomplete="name" required maxlength="80" value="${e(values.name)}"${field("name")}>
          ${error("name")}
        </div>
        <div class="field">
          <label for="contact-email">Email</label>
          <input id="contact-email" name="email" type="email" autocomplete="email" required maxlength="254" value="${e(values.email)}"${field("email")}>
          ${error("email")}
        </div>
      </div>
      <div class="field">
        <label for="contact-topic">What's it about?</label>
        <select id="contact-topic" name="topic"${field("topic")}>
${contact.topics.map((topic) => `          <option${values.topic === topic ? " selected" : ""}>${e(topic)}</option>`).join("\n")}
        </select>
        ${error("topic")}
      </div>
      <div class="field">
        <label for="contact-message">Message</label>
        <textarea id="contact-message" name="message" rows="6" required maxlength="2000"${field("message")}>${e(values.message)}</textarea>
        ${error("message")}
      </div>
      ${honeypot("contact")}
      <button class="button" type="submit">${e(contact.button)} ${ARROW}</button>
    </form>
  </section>
</div>`;
  return layout({ title: `Contact | ${profile.brand}`, description: contact.body, robots: nav.robots, ribbon: nav.ribbon, bodyClass: "page-simple", main });
}

// ---------------------------------------------------------------- thanks

export function thanksPage({ nav, kind }) {
  const text = kind === "message" ? contact.thanks : emailList.thanks;
  const main = `<section class="card simple-card" aria-labelledby="thanks-title">
  <img class="thanks-img" src="/img/slice.svg" alt="" width="160" height="120">
  <h1 id="thanks-title" class="page-title">Thank you!</h1>
  <p>${e(text)}</p>
  ${nav.demo ? nav.demo.thanksNote() : ""}
  <p class="simple-actions"><a class="button" href="${e(nav.href("/"))}">Back to ${e(profile.brand)}</a></p>
</section>`;
  return layout({ title: `Thank you | ${profile.brand}`, robots: nav.robots ?? "noindex,follow", ribbon: nav.ribbon, bodyClass: "page-simple", main });
}

// ---------------------------------------------------------------- simple pages

export function messagePage({ nav, title, heading, body, action }) {
  const main = `<section class="card simple-card" aria-labelledby="message-title">
  ${logoMark(64)}
  <h1 id="message-title" class="page-title">${e(heading)}</h1>
  <p>${e(body)}</p>
  ${action ? `<p class="simple-actions"><a class="button" href="${e(action.href)}">${e(action.label)}</a></p>` : ""}
</section>`;
  return layout({ title: `${title} | ${profile.brand}`, robots: "noindex,follow", ribbon: nav.ribbon, bodyClass: "page-simple", main });
}

// ---------------------------------------------------------------- owner view

function ownerLayout({ nav, title, active, main }) {
  const tab = (href, label, key) => `<a href="${e(nav.href(href))}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const signOut = nav.demo ? "" : `<a class="owner-signout" href="/_userland/auth/logout?return_to=%2F">Sign out</a>`;
  return layout({
    title: `${title} | ${profile.brand} owner view`,
    robots: nav.robots ?? "noindex,nofollow",
    ribbon: nav.ribbon,
    bodyClass: "page-owner",
    main: `<header class="owner-header">
  <a class="owner-brand" href="${e(nav.href("/admin"))}">${logoMark(40)}<span>${e(profile.brand)}</span><span class="owner-badge">Owner</span></a>
  <nav class="owner-nav" aria-label="Owner">
    ${tab("/admin", "Inbox", "inbox")}
    ${tab("/admin/links", "Links", "links")}
    <a href="${e(nav.href("/"))}">View page</a>
    ${signOut}
  </nav>
</header>
<div class="owner-body">
${nav.demo ? nav.demo.ownerNotice() : ""}
${main}
</div>`
  });
}

export function inboxPage({ nav, tab, messages, signups, flash }) {
  const openMessages = messages.filter((m) => m.status !== "archived");
  const activeSignups = signups.filter((s) => s.status !== "archived");
  const archived = [...messages, ...signups].filter((item) => item.status === "archived");
  const newCount = openMessages.filter((m) => m.status === "new").length;
  const tabs = [
    { key: "messages", label: "Messages", count: newCount ? `${newCount} new` : String(openMessages.length) },
    { key: "list", label: "Email list", count: String(activeSignups.length) },
    { key: "archived", label: "Archived", count: String(archived.length) }
  ];
  const tabNav = `<nav class="tabs" aria-label="Inbox sections">
${tabs.map((t) => `  <a href="${e(nav.href(`/admin?tab=${t.key}`))}"${t.key === tab ? ' aria-current="page"' : ""}>${t.label} <span class="count">${e(t.count)}</span></a>`).join("\n")}
</nav>`;

  let body;
  if (tab === "list") body = emailListSection({ nav, signups: activeSignups });
  else if (tab === "archived") body = itemList({ nav, items: archived, empty: "Nothing archived yet." });
  else body = itemList({ nav, items: openMessages, empty: "No messages yet. They show up here when someone uses the contact form." });

  const main = `<div class="owner-title-row"><h1 class="page-title">Inbox</h1></div>
${flash ? `<p class="flash" role="status">${e(flash)}</p>` : ""}
${tabNav}
${body}
${domainTip()}`;
  return ownerLayout({ nav, title: "Inbox", active: "inbox", main });
}

function itemList({ nav, items, empty }) {
  if (!items.length) return `<p class="empty">${e(empty)}</p>`;
  return `<ul class="messages" role="list">
${items.map((item) => messageCard({ nav, item })).join("\n")}
</ul>`;
}

function messageCard({ nav, item }) {
  const isSignup = item.kind === "signup";
  const statusLabel = { new: "New", replied: "Replied", archived: "Archived" }[item.status] ?? "New";
  const actions = [];
  if (!isSignup && item.status !== "replied") actions.push(["replied", "Mark replied"]);
  if (item.status !== "new") actions.push(["new", isSignup ? "Put back on list" : "Move to new"]);
  if (item.status !== "archived") actions.push(["archived", "Archive"]);
  const subject = `Re: ${item.topic || "your note"}`;
  return `  <li class="message card">
    <div class="message-head">
      <p class="message-from"><strong>${e(item.name || item.email)}</strong>${item.topic ? ` <span class="chip">${e(item.topic)}</span>` : ""}${isSignup ? ` <span class="chip">Email list</span>` : ""}</p>
      <p class="message-meta"><span class="status status-${e(item.status)}">${statusLabel}</span> <time datetime="${e(item.received_at)}">${e(timeAgo(item.received_at))}</time></p>
    </div>
    ${item.message ? `<p class="message-text">${e(item.message)}</p>` : ""}
    <div class="message-foot">
      ${emailLink(item.email, { className: "reply-link", subject })}
      <form class="inline-actions" method="post" action="${e(nav.href(`/admin/inbox/${encodeURIComponent(item.id)}`))}">
        ${nav.hidden}
${actions.map(([value, label]) => `        <button class="button button-small${value === "replied" ? "" : " button-quiet"}" type="submit" name="status" value="${value}">${label}</button>`).join("\n")}
      </form>
    </div>
  </li>`;
}

// A mailto link for a real address. The public demo stores typed addresses
// partly hidden (a•••@g•••.com, see server/demo.js); those can't be emailed,
// so they show as plain text.
function emailLink(email, { className = "", subject = "" } = {}) {
  const cls = className ? ` class="${e(className)}"` : "";
  if (String(email).includes("\u2022")) return `<span${cls}>${e(email)}</span>`;
  const query = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  // encodeURI keeps the @ readable but never lets the address add fields.
  return `<a${cls} href="mailto:${e(encodeURI(email).replace(/[?&#]/g, encodeURIComponent))}${e(query)}">${e(email)}</a>`;
}

function emailListSection({ nav, signups }) {
  const rows = signups
    .map(
      (s) => `  <li class="signup-row">
    <span class="signup-who"><strong>${e(s.name || "No name given")}</strong>${emailLink(s.email)}</span>
    <time datetime="${e(s.received_at)}">${e(timeAgo(s.received_at))}</time>
    <form method="post" action="${e(nav.href(`/admin/inbox/${encodeURIComponent(s.id)}`))}">${nav.hidden}<button class="button button-small button-quiet" type="submit" name="status" value="archived" aria-label="Remove ${e(s.email)} from the list">Remove</button></form>
  </li>`
    )
    .join("\n");
  return `<section class="card list-card" aria-labelledby="list-title">
  <div class="list-head">
    <div><h2 id="list-title" class="card-title">${signups.length} ${signups.length === 1 ? "person" : "people"} on your list</h2>
    <p class="muted">Download the list and import it into the newsletter tool you already use.</p></div>
    <a class="button" href="${e(nav.href("/admin/email-list.csv"))}" download>Download list (spreadsheet)</a>
  </div>
  ${signups.length ? `<ul class="signup-rows" role="list">\n${rows}\n</ul>` : `<p class="empty">No signups yet. Share your page to get the first one.</p>`}
</section>`;
}

function domainTip() {
  return `<aside class="tip card" aria-label="Tip">
  <p><strong>Tip: use your own web address.</strong> Put this page at an address like links.yourstudio.com. Your own domain needs the Starter plan, and your coding agent can set it up for you.</p>
</aside>`;
}

// ---------------------------------------------------------------- links manager

export function linksPage({ nav, links, values = {}, errors = {}, flash }) {
  const rows = links
    .map((link, index) => {
      const badges = [link.featured ? `<span class="chip chip-cobalt">Featured</span>` : "", link.visible === false ? `<span class="chip chip-muted">Hidden</span>` : ""].join(" ");
      const actionUrl = e(nav.href(`/admin/links/${encodeURIComponent(link.id)}`));
      const title = e(link.title);
      return `  <li class="manage-row card${link.visible === false ? " is-hidden" : ""}">
    <span class="link-thumb">${picture(link.picture, "thumb-img", [56, 56])}</span>
    <span class="manage-text">
      <span class="manage-title">${title} ${badges}</span>
      <span class="manage-url">${e(link.url)}</span>
      <span class="manage-meta">${e(link.clicks ?? 0)} ${Number(link.clicks) === 1 ? "tap" : "taps"}${link.price ? ` &middot; ${e(link.price)}` : ""}</span>
    </span>
    <form class="manage-actions" method="post" action="${actionUrl}">
      ${nav.hidden}
      <button class="icon-button" type="submit" name="action" value="up" aria-label="Move up: ${title}"${index === 0 ? " disabled" : ""}><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="icon-button" type="submit" name="action" value="down" aria-label="Move down: ${title}"${index === links.length - 1 ? " disabled" : ""}><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v13m-6-6 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="button button-small button-quiet" type="submit" name="action" value="${link.visible === false ? "show" : "hide"}" aria-label="${link.visible === false ? "Show" : "Hide"}: ${title}">${link.visible === false ? "Show" : "Hide"}</button>
      <a class="button button-small" href="${actionUrl}" aria-label="Edit: ${title}">Edit</a>
    </form>
  </li>`;
    })
    .join("\n");

  const empty = `<section class="card empty-card">
  <h2 class="card-title">No links yet</h2>
  <p>Start with the sample links for ${e(profile.brand)}, then edit them, or add your own below.</p>
  <form method="post" action="${e(nav.href("/admin/links/starter"))}">${nav.hidden}<button class="button" type="submit">Add starter links</button></form>
</section>`;

  const main = `<div class="owner-title-row"><h1 class="page-title">Links</h1></div>
<p class="lead">Featured items show as product cards with a price. Everything else shows in the list of links. Taps count each time someone uses a link.</p>
${flash ? `<p class="flash" role="status">${e(flash)}</p>` : ""}
${links.length ? `<ul class="manage-list" role="list">\n${rows}\n</ul>` : empty}
<section class="card form-card" aria-labelledby="add-title">
  <h2 id="add-title" class="card-title">Add a link</h2>
  ${linkForm({ nav, action: "/admin/links", values: { visible: true, ...values }, errors, submit: "Add link" })}
</section>`;
  return ownerLayout({ nav, title: "Links", active: "links", main });
}

export function editLinkPage({ nav, link, values, errors = {} }) {
  const current = values ?? link;
  const main = `<p class="back"><a href="${e(nav.href("/admin/links"))}"><span aria-hidden="true">&larr;</span> All links</a></p>
<section class="card form-card" aria-labelledby="edit-title">
  <h1 id="edit-title" class="page-title">Edit link</h1>
  ${linkForm({ nav, action: `/admin/links/${encodeURIComponent(link.id)}`, values: current, errors, submit: "Save changes", actionName: "save" })}
</section>
<section class="card danger-card" aria-labelledby="delete-title">
  <h2 id="delete-title" class="card-title">Delete this link</h2>
  <p>It comes off your page right away. To keep it for later, hide it instead.</p>
  <form method="post" action="${e(nav.href(`/admin/links/${encodeURIComponent(link.id)}`))}">${nav.hidden}<button class="button button-danger" type="submit" name="action" value="delete">Delete link</button></form>
</section>`;
  return ownerLayout({ nav, title: "Edit link", active: "links", main });
}

function linkForm({ nav, action, values, errors, submit, actionName }) {
  const field = (name) => (errors[name] ? ` aria-invalid="true" aria-describedby="link-${name}-error"` : "");
  const error = (name) => (errors[name] ? `<p class="field-error" id="link-${name}-error">${e(errors[name])}</p>` : "");
  return `<form class="stack" method="post" action="${e(nav.href(action))}" novalidate>
    ${nav.hidden}
    ${actionName ? `<input type="hidden" name="action" value="${e(actionName)}">` : ""}
    ${Object.keys(errors).length ? `<p class="form-error" role="alert">Please fix the highlighted fields.</p>` : ""}
    <div class="field-row">
      <div class="field">
        <label for="link-title">Title</label>
        <input id="link-title" name="title" type="text" required maxlength="80" value="${e(values.title)}"${field("title")}>
        ${error("title")}
      </div>
      <div class="field">
        <label for="link-url">Web address</label>
        <input id="link-url" name="url" type="url" required maxlength="500" placeholder="https://" value="${e(values.url)}"${field("url")}>
        ${error("url")}
      </div>
    </div>
    <div class="field">
      <label for="link-note">Short note <span class="optional">(optional)</span></label>
      <input id="link-note" name="note" type="text" maxlength="140" value="${e(values.note)}"${field("note")}>
      ${error("note")}
    </div>
    <div class="field-row">
      <div class="field">
        <label for="link-picture">Picture</label>
        <select id="link-picture" name="picture">
${pictures.map((p) => `          <option value="${e(p.value)}"${values.picture === p.value ? " selected" : ""}>${e(p.label)}</option>`).join("\n")}
        </select>
      </div>
      <div class="field">
        <label for="link-price">Price <span class="optional">(featured items)</span></label>
        <input id="link-price" name="price" type="text" maxlength="20" placeholder="$48" value="${e(values.price)}"${field("price")}>
        ${error("price")}
      </div>
    </div>
    <div class="checks">
      <label class="check"><input type="checkbox" name="featured" value="yes"${values.featured ? " checked" : ""}> Show as a featured product</label>
      <label class="check"><input type="checkbox" name="visible" value="yes"${values.visible !== false ? " checked" : ""}> Show on my page</label>
    </div>
    <button class="button" type="submit">${e(submit)}</button>
  </form>`;
}

// ---------------------------------------------------------------- helpers

export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

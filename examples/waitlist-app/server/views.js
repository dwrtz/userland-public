// HTML for every page. All values from people or storage go through escapeHtml().

import { LIMITS, QUESTIONS, REFERRAL_BOOST, SORTS, PAGE_SIZE, TRAP_FIELD } from "./waitlist.js";

export const BRAND = {
  name: "Velto",
  tagline: "Find your pace people.",
  description: "Velto matches you with runners nearby who run your pace, at the times you actually run. Join the waitlist for early access.",
  // Where people write when they lost their private link. Replace with your own address.
  contactEmail: "hello@example.com"
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Builds a same-app path with a query string, skipping empty values.
// `keep` holds values that ride along on every link (the demo key).
export function pathWith(path, params = {}, keep = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...keep })) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

// The same, escaped for use inside an href="..." attribute.
export function href(path, params = {}, keep = {}) {
  return escapeHtml(pathWith(path, params, keep));
}

function hiddenFields(keep = {}) {
  return Object.entries(keep)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
}

const numberFormat = new Intl.NumberFormat("en-US");
const fmt = (value) => numberFormat.format(value);

export function timeAgo(iso, now = new Date()) {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function firstName(row) {
  return (row?.name || "").split(" ")[0] || "";
}

function displayName(row) {
  return row.name || row.email.split("@")[0];
}

// The logo: a volt tile with a forward-leaning V made of two strides.
export function logoMark(size = 32) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="9" fill="var(--volt)"/><path d="M8.5 9.5 14.8 22.5 23.5 9.5" fill="none" stroke="var(--ink)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 16.5h4.2M6 20.5h3.6" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round"/></svg>`;
}

function logo(homeHref = "/") {
  return `<a class="logo" href="${escapeHtml(homeHref)}" aria-label="${BRAND.name} home">${logoMark()}<span class="logo__word">velto</span></a>`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function layout({ title, description = BRAND.description, body, site, bodyClass = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${site.robots ?? ""}
<meta name="theme-color" content="#0b0c0e">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/unbounded-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
${site.banner ?? ""}
${body}
<footer class="footer">
  <div class="wrap footer__inner">
    <p>&copy; ${new Date().getUTCFullYear()} ${BRAND.name}. Made for runners who'd rather not run alone.</p>
    ${site.footer ?? ""}
  </div>
</footer>
<script src="/assets/share.js" defer></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

function joinForm({ values = {}, errors = {}, keep = {}, referrer }) {
  const emailError = errors.email ? `<p class="field__error" id="email-error">${escapeHtml(errors.email)}</p>` : "";
  const nameError = errors.name ? `<p class="field__error" id="name-error">${escapeHtml(errors.name)}</p>` : "";
  const invited = referrer
    ? `<p class="join__invite"><span class="dot" aria-hidden="true"></span>${escapeHtml(firstName(referrer) || "A friend")} saved you a spot. Join and you both move up.</p>`
    : "";
  return `<form class="join" method="post" action="/join" novalidate>
  ${invited}
  <div class="join__row">
    <div class="field field--email">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="${LIMITS.email}" required placeholder="you@example.com" value="${escapeHtml(values.email)}"${
        errors.email ? ' aria-invalid="true" aria-describedby="email-error"' : ""
      }>
      ${emailError}
    </div>
    <div class="field field--name">
      <label for="name">First name <span class="optional">optional</span></label>
      <input id="name" name="name" type="text" autocomplete="given-name" maxlength="${LIMITS.name}" placeholder="Maya" value="${escapeHtml(values.name)}"${
        errors.name ? ' aria-invalid="true" aria-describedby="name-error"' : ""
      }>
      ${nameError}
    </div>
  </div>
  <div class="hp" aria-hidden="true">
    <label for="${TRAP_FIELD}">Leave this empty</label>
    <input id="${TRAP_FIELD}" name="${TRAP_FIELD}" type="text" tabindex="-1" autocomplete="off">
  </div>
  <input type="hidden" name="ref" value="${escapeHtml(values.ref)}">
  <input type="hidden" name="source" value="${escapeHtml(values.source)}">
  ${hiddenFields(keep)}
  <button class="button button--volt" type="submit">Get early access <span aria-hidden="true">&rarr;</span></button>
  <p class="join__fine">One email when your invite is ready. No spam, ever.</p>
</form>`;
}

function phoneMock() {
  return `<div class="device-wrap" aria-hidden="true">
<p class="bump"><span class="bump__from">#142</span><span class="bump__arrow">&rarr;</span><span class="bump__to">#132</span><span class="bump__note">One friend joined</span></p>
<div class="device">
  <div class="device__screen">
    <p class="device__eyebrow">Tuesday &middot; 6:30 am</p>
    <p class="device__title">Your pace crew</p>
    <div class="match">
      <div class="match__avatars"><span class="av av--1">M</span><span class="av av--2">J</span><span class="av av--3">P</span></div>
      <div>
        <p class="match__name">River loop, 8 km</p>
        <p class="match__meta">3 runners &middot; 5:40 /km</p>
      </div>
    </div>
    <svg class="pace" viewBox="0 0 240 70" preserveAspectRatio="none"><path d="M0 52 C 30 48, 40 30, 70 34 S 110 50, 135 36 S 180 12, 205 20 S 232 30, 240 24" fill="none" stroke="var(--volt)" stroke-width="3" stroke-linecap="round"/><path d="M0 52 C 30 48, 40 30, 70 34 S 110 50, 135 36 S 180 12, 205 20 S 232 30, 240 24 V70 H0Z" fill="url(#g)" opacity=".35"/><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#d4ff3a"/><stop offset="1" stop-color="#d4ff3a" stop-opacity="0"/></linearGradient></defs></svg>
    <div class="device__stats"><div><b>5:40</b><span>avg pace</span></div><div><b>0.8 km</b><span>to start</span></div><div><b>92%</b><span>match</span></div></div>
    <p class="device__cta">I'm in</p>
  </div>
</div>
</div>`;
}

export function landingPage({ site, values, errors, joined, referrer, keep }) {
  // Social proof once the list has some momentum. `joined.more` means "at least this many".
  const count =
    joined.count >= 25 ? `<p class="proof"><b>${fmt(joined.count)}${joined.more ? "+" : ""}</b> runners have already joined.</p>` : "";
  const body = `<header class="top"><div class="wrap top__inner">${logo(pathWith("/", {}, keep))}<p class="top__tag">Early access &middot; Winter 2027</p></div></header>
<main id="main">
  <section class="hero">
    <div class="wrap hero__grid">
      <div class="hero__copy">
        <p class="pill">Launching in 12 cities</p>
        <h1 class="hero__title">Find your <em>pace</em> people.</h1>
        <p class="hero__lede">Velto matches you with runners near you who run your pace, at the times you actually run. Get in before launch.</p>
        ${joinForm({ values, errors, keep, referrer })}
        ${count}
      </div>
      ${phoneMock()}
    </div>
  </section>
  <section class="how" aria-labelledby="how-title">
    <div class="wrap">
      <h2 id="how-title" class="section-title">How early access works</h2>
      <ol class="steps">
        <li><span class="steps__n">01</span><h3>Save your spot</h3><p>Join with your email. You'll get a private page with your place in line.</p></li>
        <li><span class="steps__n">02</span><h3>Bring your crew</h3><p>Every friend who joins with your link moves you up ${REFERRAL_BOOST} places.</p></li>
        <li><span class="steps__n">03</span><h3>Run together</h3><p>We open Velto city by city. First in line, first on the road.</p></li>
      </ol>
    </div>
  </section>
</main>`;
  return layout({ title: `${BRAND.name}: ${BRAND.tagline}`, body, site, bodyClass: "page-landing" });
}

function answerOptions(question, selected) {
  return Object.entries(QUESTIONS[question].options)
    .map(
      ([value, label]) =>
        `<label class="choice"><input type="radio" name="${question}" value="${escapeHtml(value)}"${selected === value ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`
    )
    .join("");
}

export function statusPage({ site, signup, position, waitingCount, shareUrl, statusPath, saved, keep = {} }) {
  const name = firstName(signup);
  const inLine = signup.status === "waiting";
  const headline = signup.status === "invited" ? "Your invite is ready." : name ? `You're in, ${escapeHtml(name)}.` : "You're in.";
  // Every waiting person has a place, but if one is ever missing, say so plainly instead of "#NaN".
  const place = inLine && !Number.isFinite(position)
    ? `<div class="place"><p class="place__label">Your place in line</p><p class="place__number place__number--word">Saved</p><p class="place__meta">Your spot is saved. Check back soon to see your number.</p></div>`
    : inLine
    ? `<div class="place"><div><p class="place__label">Your place in line</p><p class="place__number"><span aria-hidden="true">#</span>${fmt(position)}</p><p class="place__meta">of ${fmt(waitingCount)} runners waiting</p></div>${
        position > 1
          ? `<p class="place__next"><span>One friend gets you to</span><b>#${fmt(Math.max(1, position - REFERRAL_BOOST))}</b></p>`
          : `<p class="place__next"><span>You're</span><b>first in line</b></p>`
      }</div>`
    : `<div class="place"><p class="place__label">Status</p><p class="place__number place__number--word">${signup.status === "invited" ? "Invited" : "Closed"}</p><p class="place__meta">${
        signup.status === "invited" ? "Check your email for your invite." : "This spot is no longer active."
      }</p></div>`;
  const referrals = signup.referrals
    ? `<p class="share__count"><b>${fmt(signup.referrals)}</b> ${signup.referrals === 1 ? "friend has" : "friends have"} joined with your link.</p>`
    : `<p class="share__count">No friends yet. Your first one moves you up ${REFERRAL_BOOST} places.</p>`;
  const mail = `mailto:?subject=${encodeURIComponent("Run with me on Velto")}&body=${encodeURIComponent(
    `I'm on the Velto waitlist. It matches you with runners at your pace nearby. Join with my link and we both move up: ${shareUrl}`
  )}`;
  const sms = `sms:?&body=${encodeURIComponent(`Join me on the Velto waitlist: ${shareUrl}`)}`;
  const answered = signup.frequency || signup.goal || signup.city;
  const savedNote = saved ? `<p class="notice" role="status">Thanks! Your answers are saved.</p>` : "";

  const body = `<header class="top"><div class="wrap top__inner">${logo(site.home)}<p class="top__tag">Early access &middot; Winter 2027</p></div></header>
<main id="main" class="wrap status">
  <section class="status__hero">
    <h1 class="status__title">${headline}</h1>
    ${place}
  </section>
  <section class="card share" aria-labelledby="share-title">
    <h2 id="share-title" class="card__title">Move up the line</h2>
    <p>Each friend who joins with your link moves you up ${REFERRAL_BOOST} places.</p>
    <div class="share__link">
      <label for="share-url" class="sr-only">Your invite link</label>
      <input id="share-url" type="text" readonly value="${escapeHtml(shareUrl)}">
      <button class="button button--volt" type="button" data-copy="#share-url" hidden>Copy link</button>
    </div>
    <p class="share__buttons"><a class="button button--ghost" href="${escapeHtml(mail)}">Email a friend</a><a class="button button--ghost" href="${escapeHtml(sms)}">Text a friend</a></p>
    ${referrals}
    ${site.shareNote ?? ""}
  </section>
  <section class="card" aria-labelledby="questions-title">
    <h2 id="questions-title" class="card__title">Help us plan your launch <span class="optional">optional</span></h2>
    <p>Two quick questions so we open the right cities with the right runs.</p>
    ${savedNote}
    <form method="post" action="${escapeHtml(statusPath)}/answers" class="questions">${hiddenFields(keep)}
      <fieldset><legend>${escapeHtml(QUESTIONS.frequency.label)}</legend><div class="choices">${answerOptions("frequency", signup.frequency)}</div></fieldset>
      <fieldset><legend>${escapeHtml(QUESTIONS.goal.label)}</legend><div class="choices">${answerOptions("goal", signup.goal)}</div></fieldset>
      <div class="field"><label for="city">Your city</label><input id="city" name="city" type="text" autocomplete="address-level2" maxlength="${LIMITS.city}" value="${escapeHtml(signup.city)}" placeholder="Portland"></div>
      <button class="button button--light" type="submit">${answered ? "Update answers" : "Save answers"}</button>
    </form>
  </section>
  <p class="status__private">Bookmark this page. It's your private link to check your place in line.</p>
</main>`;
  return layout({ title: `Your place in line - ${BRAND.name}`, body, site, bodyClass: "page-status" });
}

// `copyValue` shows a read-only box with a copy button (used for a new private link).
export function messagePage({ site, title, heading, message, action, copyValue, status = 200 }) {
  const link = action ? `<p><a class="button button--volt" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : "";
  const copy = copyValue
    ? `<div class="share__link"><label for="copy-value" class="sr-only">Link</label><input id="copy-value" type="text" readonly value="${escapeHtml(copyValue)}"><button class="button button--light" type="button" data-copy="#copy-value" hidden>Copy link</button></div>`
    : "";
  const body = `<header class="top"><div class="wrap top__inner">${logo(site.home)}</div></header>
<main id="main" class="wrap message"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>${copy}${link}</main>`;
  return { html: layout({ title: `${title} - ${BRAND.name}`, body, site, bodyClass: "page-message" }), status };
}

// ---------------------------------------------------------------------------
// Owner view
// ---------------------------------------------------------------------------

function select(name, label, options, selected, allLabel) {
  const items = Object.entries(options)
    .map(([value, text]) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(text)}</option>`)
    .join("");
  return `<div class="field"><label for="f-${name}">${escapeHtml(label)}</label><select id="f-${name}" name="${name}">${
    allLabel ? `<option value="">${escapeHtml(allLabel)}</option>` : ""
  }${items}</select></div>`;
}

function actionForm(row, action, fields, label, style, ariaLabel, keep, back) {
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  return `<form method="post" action="/admin/signups/${escapeHtml(row.id)}/${action}">
      ${hidden}<input type="hidden" name="back" value="${escapeHtml(back)}">${hiddenFields(keep)}
      <button class="button button--small ${style}" type="submit" aria-label="${escapeHtml(`${ariaLabel} ${displayName(row)}`)}">${label}</button>
    </form>`;
}

function statusActions(row, keep, back) {
  const moves = {
    waiting: [["invited", "Invite"], ["archived", "Archive"]],
    invited: [["waiting", "Move back"]],
    archived: [["waiting", "Restore"]]
  }[row.status];
  const forms = moves.map(([next, label]) =>
    actionForm(row, "status", { status: next }, label, next === "invited" ? "button--volt" : "button--ghost", label, keep, back)
  );
  // A new private link for someone who lost theirs; deleting frees room on the plan.
  if (row.status !== "archived") forms.push(actionForm(row, "link", {}, "New link", "button--ghost", "Make a new private link for", keep, back));
  else forms.push(actionForm(row, "delete", {}, "Delete", "button--danger", "Delete for good", keep, back));
  return forms.join("");
}

// Bulk buttons under the list. Archive shows only for a search or filter;
// Delete shows only on the Archived list.
function bulkActions({ filters, rows, keep, back, bulkLimit }) {
  const narrowed = filters.q || filters.status || filters.frequency || filters.goal;
  const toArchive = rows.filter((row) => row.status !== "archived").length;
  const toDelete = rows.filter((row) => row.status === "archived").length;
  const kept = { q: filters.q, status: filters.status, frequency: filters.frequency, goal: filters.goal, back, ...keep };
  const fields = Object.entries(kept)
    .filter(([, value]) => value)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const count = (total) => (total > bulkLimit ? `the first ${fmt(bulkLimit)} of ${fmt(total)}` : total === 1 ? "this person" : `these ${fmt(total)}`);
  let button = "";
  let note = "";
  if (filters.status === "archived" && toDelete) {
    button = `<button class="button button--small button--danger" type="submit" name="action" value="delete">Delete ${count(toDelete)} for good</button>`;
    note = "Deleting removes people for good and frees room on your plan. It can't be undone.";
  } else if (narrowed && filters.status !== "archived" && toArchive) {
    button = `<button class="button button--small button--ghost" type="submit" name="action" value="archive">Archive ${count(toArchive)}</button>`;
    note = "Archived people leave the line and stop counting as referrals. You can restore them later.";
  }
  if (!button) return "";
  return `<form class="bulk" method="post" action="/admin/bulk">${fields}${button}<p class="bulk__note">${note}</p></form>`;
}

function statusChip(status) {
  const text = { waiting: "Waiting", invited: "Invited", archived: "Archived" }[status];
  return `<span class="chip chip--${status}">${text}</span>`;
}

export function ownerPage({ site, rows, filters, positions, stats, referrers, activity, total, keep, user, notice, bulkLimit = 50, now = new Date() }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const filterParams = { q: filters.q, status: filters.status, frequency: filters.frequency, goal: filters.goal, sort: filters.sort === "line" ? "" : filters.sort };
  const back = pathWith("/admin", { ...filterParams, page: page > 1 ? page : "" });
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const tableRows = pageRows
    .map((row) => {
      const answers = [QUESTIONS.frequency.options[row.frequency], QUESTIONS.goal.options[row.goal], row.city].filter(Boolean);
      return `<tr>
      <td class="t-pos" data-label="Place">${positions.has(row.id) ? `#${fmt(positions.get(row.id))}` : "&ndash;"}</td>
      <td class="t-person" data-label="Person"><b>${escapeHtml(displayName(row))}</b><span title="${escapeHtml(row.email)}">${escapeHtml(row.email)}</span></td>
      <td class="t-answers" data-label="Answers">${answers.length ? answers.map((text) => `<span class="tag">${escapeHtml(text)}</span>`).join("") : '<span class="muted">No answers yet</span>'}</td>
      <td class="t-num" data-label="Friends">${fmt(row.referrals)}</td>
      <td class="t-when" data-label="Joined"><time datetime="${escapeHtml(row.joined_at)}">${timeAgo(row.joined_at, now)}</time></td>
      <td class="t-status" data-label="Status">${statusChip(row.status)}</td>
      <td class="t-actions"><div class="actions">${statusActions(row, keep, back)}</div></td>
    </tr>`;
    })
    .join("");

  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Pages">${page > 1 ? `<a href="${href("/admin", { ...filterParams, page: page - 1 }, keep)}">&larr; Previous</a>` : "<span></span>"}<span>Page ${page} of ${pages}</span>${
          page < pages ? `<a href="${href("/admin", { ...filterParams, page: page + 1 }, keep)}">Next &rarr;</a>` : "<span></span>"
        }</nav>`
      : "";

  const activityItems = activity
    .map((item) => {
      const who = `<b>${escapeHtml(displayName(item.row))}</b>`;
      const text =
        item.kind === "referred"
          ? `${who} joined with ${item.referrer ? escapeHtml(displayName(item.referrer)) : "a friend"}'s link`
          : item.kind === "invited"
            ? `${who} was invited`
            : `${who} joined the list`;
      return `<li><span class="feed__dot feed__dot--${item.kind}" aria-hidden="true"></span><p>${text}</p><time datetime="${escapeHtml(item.at)}">${timeAgo(item.at, now)}</time></li>`;
    })
    .join("");

  const referrerItems = referrers.length
    ? referrers.map((row) => `<li><span>${escapeHtml(displayName(row))}</span><b>${fmt(row.referrals)}</b></li>`).join("")
    : '<li class="muted">No referrals yet.</li>';

  const account = user
    ? `<p class="owner-top__user"><span>${escapeHtml(user.email)}</span><a href="/_userland/auth/logout?return_to=%2F">Sign out</a></p>`
    : "";
  const exportHref = href("/admin/export.csv", filterParams, keep);
  const flash = notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : "";

  const body = `<header class="top top--owner"><div class="wrap wrap--wide top__inner">${logo(pathWith("/", {}, keep))}<p class="top__tag">Owner view</p>${account}</div></header>
<main id="main" class="wrap wrap--wide owner">
  <div class="owner__head">
    <h1>Waitlist</h1>
    <a class="button button--light" href="${exportHref}" download>Download CSV</a>
  </div>
  ${flash}
  <dl class="stats">
    <div><dt>Waiting</dt><dd>${fmt(stats.waiting)}</dd></div>
    <div><dt>Joined this week</dt><dd>${fmt(stats.thisWeek)}</dd></div>
    <div><dt>Came from a friend</dt><dd>${stats.referredShare}%</dd></div>
    <div><dt>Invited</dt><dd>${fmt(stats.invited)}</dd></div>
  </dl>
  <div class="owner__grid">
    <section class="owner__list" aria-labelledby="list-title">
      <h2 id="list-title" class="sr-only">Signups</h2>
      <form class="filters" method="get" action="/admin">
        ${hiddenFields(keep)}
        <div class="field field--search"><label for="f-q">Search</label><input id="f-q" name="q" type="search" value="${escapeHtml(filters.q)}" placeholder="Name, email, or city"></div>
        ${select("status", "Status", { waiting: "Waiting", invited: "Invited", archived: "Archived" }, filters.status, "Everyone")}
        ${select("frequency", "Runs", QUESTIONS.frequency.options, filters.frequency, "Any")}
        ${select("goal", "Wants", QUESTIONS.goal.options, filters.goal, "Anything")}
        ${select("sort", "Sort", SORTS, filters.sort)}
        <button class="button button--light" type="submit">Apply</button>
      </form>
      <p class="owner__count">${fmt(total)} ${total === 1 ? "person" : "people"}${filters.q || filters.status || filters.frequency || filters.goal ? ` match. <a href="${href("/admin", {}, keep)}">Clear filters</a>` : ""}</p>
      ${
        pageRows.length
          ? `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Place</th><th scope="col">Person</th><th scope="col">Answers</th><th scope="col">Friends</th><th scope="col">Joined</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${tableRows}</tbody></table></div>`
          : '<p class="empty">Nobody matches these filters yet.</p>'
      }
      ${pager}
      ${bulkActions({ filters, rows, keep, back, bulkLimit })}
    </section>
    <aside class="owner__side">
      <section class="card card--tight" aria-labelledby="ref-title"><h2 id="ref-title" class="card__title">Top referrers</h2><ol class="leaders">${referrerItems}</ol></section>
      <section class="card card--tight" aria-labelledby="feed-title"><h2 id="feed-title" class="card__title">Recent activity</h2><ul class="feed">${activityItems || '<li class="muted">Nothing yet.</li>'}</ul>
      <p class="feed__more">Every signup is also saved to your app's activity log in Userland.</p></section>
    </aside>
  </div>
</main>`;
  return layout({ title: `Waitlist owner view - ${BRAND.name}`, body, site, bodyClass: "page-owner" });
}

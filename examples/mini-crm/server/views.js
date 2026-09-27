// HTML for every page. Server-rendered, no client JavaScript.
// Every value from a visitor or from the database goes through escapeHtml().

import { BUDGETS, LIMITS, OPEN_STAGES, PROJECTS, SOURCES, STAGES, TIMELINES, isDue, labelFor, today } from "./leads.js";

export const BUSINESS = {
  name: "Bevel & Brace",
  tagline: "Renovation Co.",
  phone: "(555) 010-0140"
};

const EXAMPLE_PAGE = "https://userland.fun/examples/mini-crm/";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MARK = `<svg class="mark" viewBox="0 0 40 40" width="36" height="36" aria-hidden="true" focusable="false"><rect width="40" height="40" rx="7" fill="#F26A1B"/><path d="M9 6h6v21h19v6H9z" fill="#13202F"/><g fill="#F26A1B"><rect x="12" y="9.5" width="3" height="1.6"/><rect x="13" y="13.5" width="2" height="1.6"/><rect x="12" y="17.5" width="3" height="1.6"/><rect x="13" y="21.5" width="2" height="1.6"/></g><path d="M19 12.5 30.5 24" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/></svg>`;

const ICON = {
  check: `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M4 10.5 8 14.5 16 5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  back: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false"><path d="M12 4 6 10l6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  flag: `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false"><path d="M5 17V3.5m0 0h9l-2 3.5 2 3.5H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
};

// ---------------------------------------------------------------------------
// Dates. Stored as ISO strings; shown in plain words. Dates use UTC so the
// server and tests agree; change timeZone below to your business's zone.
// ---------------------------------------------------------------------------

const TIME_ZONE = "UTC";
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TIME_ZONE });
const longDate = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TIME_ZONE });

export function timeAgo(iso, now) {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return shortDate.format(new Date(iso));
}

function followUpLabel(date, now) {
  if (!date) return "";
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today(now)}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return days === -1 ? "Overdue since yesterday" : `Overdue ${-days} days`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return longDate.format(new Date(`${date}T12:00:00Z`));
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function stageChip(stage) {
  return `<span class="chip chip-${escapeHtml(stage)}">${escapeHtml(labelFor(STAGES, stage))}</span>`;
}

/**
 * A mailto: link for a saved address. The address is percent-encoded (except
 * the @) so nothing in it can add a subject, body, or extra recipients.
 */
export function mailtoHref(email) {
  return `mailto:${encodeURIComponent(email).replace("%40", "@")}`;
}

function brand(href) {
  return `<a class="brand" href="${escapeHtml(href)}">${MARK}<span class="brand-text"><span class="brand-name">${escapeHtml(BUSINESS.name)}</span><span class="brand-tag">${escapeHtml(BUSINESS.tagline)}</span></span></a>`;
}

// Demo notices. What a visitor saves is tied to the demo link in their
// address bar (see server/demo.js), so the copy says so plainly and asks for
// made-up details instead of promising privacy the demo can't give.
const DEMO_LINK_NOTE = "Anyone with this page's link can see what you add.";

function demoKeepNote(rc) {
  return rc.demoKeepHours ? ` Demo entries are removed after ${rc.demoKeepHours} hours.` : "";
}

function demoBar(rc, area) {
  if (!rc.demo) return "";
  const text =
    area === "owner"
      ? `You're seeing the owner's side without signing in.<span class="demo-more"> The real app asks the owner to sign in first.</span> Use made-up details.`
      : `Send a request with made-up details, then open the owner view to see it arrive.`;
  return `<div class="demo-bar" role="note"><div class="wrap demo-bar-inner"><p><strong>Demo app.</strong> ${text} ${DEMO_LINK_NOTE}${demoKeepNote(rc)}</p><a href="${EXAMPLE_PAGE}">Built with Userland. See how it's made</a></div></div>`;
}

/** The line under the estimate form's heading: a privacy promise, or a demo warning. */
function formNote(rc) {
  if (!rc.demo) return `<p class="card-sub">No cost, no pressure. We only use your details to reply about this project.</p>`;
  const restart = rc.key ? ` This link already holds earlier demo entries. <a href="/">Start a new demo</a>.` : "";
  return `<p class="demo-note" role="note"><strong>This is a demo, so nobody will contact you.</strong> Please use made-up details. ${DEMO_LINK_NOTE}${demoKeepNote(rc)}${restart}</p>`;
}

function siteHeader(rc, area) {
  const nav =
    area === "owner"
      ? `<nav class="nav" aria-label="Owner"><a href="${rc.href("/admin")}"${rc.page === "board" ? ' aria-current="page"' : ""}>Leads</a><a href="${rc.href("/admin/leads/new")}"${rc.page === "new" ? ' aria-current="page"' : ""}>Add a lead</a><a href="${rc.href("/")}">Customer form</a>${rc.user ? `<a href="/_userland/auth/logout">Sign out</a>` : ""}</nav>`
      : `<nav class="nav" aria-label="Main"><a class="nav-phone" href="tel:${BUSINESS.phone.replace(/[^0-9+]/g, "")}">${escapeHtml(BUSINESS.phone)}</a>${rc.demo ? `<a class="nav-owner" href="${rc.href("/admin")}">Owner view</a>` : ""}</nav>`;
  return `<header class="site-header ${area === "owner" ? "is-owner" : ""}"><div class="wrap header-inner">${brand(area === "owner" ? rc.href("/admin") : rc.href("/"))}${area === "owner" ? `<span class="area-label">Lead board</span>` : ""}${nav}</div></header>`;
}

function siteFooter(rc) {
  const credit = rc.demo ? `<p class="credit">Demo app. <a href="${EXAMPLE_PAGE}">Built with Userland. See how it's made</a>.</p>` : "";
  return `<footer class="site-footer"><div class="wrap footer-inner"><p>${escapeHtml(BUSINESS.name)} ${escapeHtml(BUSINESS.tagline)} · Kitchens, baths, basements, and additions. Licensed and insured.</p>${credit}</div></footer>`;
}

export function layout(rc, { title, area = "public", body }) {
  // The public demo is never indexed (it links back to the example page).
  // Owner pages are private, so they are never indexed either.
  const robots = rc.demo ? "noindex,follow" : area === "owner" ? "noindex,nofollow" : "";
  const pageTitle = area === "owner" ? `${title} · ${BUSINESS.name} leads` : `${title} · ${BUSINESS.name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${robots ? `<meta name="robots" content="${robots}">\n` : ""}<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(BUSINESS.name)} builds and remodels kitchens, baths, basements, and additions. Request a free estimate.">
<meta name="theme-color" content="#13202F">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/ibm-plex-sans-condensed-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/barlow-condensed-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/crm.css">
</head>
<body class="area-${area}">
<a class="skip" href="#main">Skip to content</a>
${demoBar(rc, area)}${siteHeader(rc, area)}
<main id="main" tabindex="-1">
${body}
</main>
${siteFooter(rc)}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

function fieldError(name, errors) {
  return errors[name] ? `<p class="field-error" id="${name}-error">${escapeHtml(errors[name])}</p>` : "";
}

function describedBy(name, errors, hint) {
  const ids = [hint ? `${name}-hint` : "", errors[name] ? `${name}-error` : ""].filter(Boolean).join(" ");
  return `${ids ? ` aria-describedby="${ids}"` : ""}${errors[name] ? ' aria-invalid="true"' : ""}`;
}

function input({ name, label, type = "text", values, errors, required = false, max, autocomplete, hint, optional = false }) {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}${optional ? ' <span class="optional">optional</span>' : ""}</label>${hint ? `<p class="hint" id="${name}-hint">${escapeHtml(hint)}</p>` : ""}<input id="${name}" name="${name}" type="${type}" value="${escapeHtml(values[name])}"${max ? ` maxlength="${max}"` : ""}${required ? " required" : ""}${autocomplete ? ` autocomplete="${autocomplete}"` : ""}${describedBy(name, errors, hint)}>${fieldError(name, errors)}</div>`;
}

function select({ name, label, options, values, errors, placeholder, required = true, optional = false }) {
  const choices = options.map((option) => `<option value="${option.value}"${values[name] === option.value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
  return `<div class="field"><label for="${name}">${escapeHtml(label)}${optional ? ' <span class="optional">optional</span>' : ""}</label><select id="${name}" name="${name}"${required ? " required" : ""}${describedBy(name, errors)}><option value="">${escapeHtml(placeholder)}</option>${choices}</select>${fieldError(name, errors)}</div>`;
}

function textarea({ name, label, values, errors, max, rows = 4, required = false, hint, placeholder = "" }) {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label>${hint ? `<p class="hint" id="${name}-hint">${escapeHtml(hint)}</p>` : ""}<textarea id="${name}" name="${name}" rows="${rows}" maxlength="${max}"${required ? " required" : ""}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""}${describedBy(name, errors, hint)}>${escapeHtml(values[name])}</textarea>${fieldError(name, errors)}</div>`;
}

function errorSummary(errors) {
  const entries = Object.entries(errors);
  if (entries.length === 0) return "";
  return `<div class="error-summary" role="alert"><h2>Check ${entries.length === 1 ? "this field" : `these ${entries.length} fields`}</h2><ul>${entries.map(([name, message]) => `<li><a href="#${name}">${escapeHtml(message)}</a></li>`).join("")}</ul></div>`;
}

/** Hidden fields every form carries: the demo key (demo only) and the honeypot. */
function hiddenFields(rc, { honeypot = false } = {}) {
  const key = rc.key ? `<input type="hidden" name="demo" value="${escapeHtml(rc.key)}">` : "";
  // People never see this field. Bots that fill every input do, and their
  // submissions are dropped without saving.
  const trap = honeypot ? `<div class="trap" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>` : "";
  return key + trap;
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

export function homePage(rc, { values = {}, errors = {} } = {}) {
  const body = `
<section class="hero">
  <div class="wrap hero-grid">
    <div class="hero-intro">
      <p class="eyebrow">Kitchens · Baths · Basements · Additions</p>
      <h1>Remodels built square. Quotes you can read.</h1>
      <p class="lede">Tell us about your project. A crew lead calls you back within one business day to set up a free walkthrough.</p>
    </div>
    <div class="hero-more">
      <ul class="promises">
        <li>${ICON.check}<span><strong>Licensed and insured</strong> for every trade we bring on site.</span></li>
        <li>${ICON.check}<span><strong>Line-item written quotes</strong>, so you know where every dollar goes.</span></li>
        <li>${ICON.check}<span><strong>One crew lead</strong> from demolition to the final walkthrough.</span></li>
      </ul>
      <ol class="steps" aria-label="How it works">
        <li><span class="step-num">01</span><span><strong>Send your request</strong>Takes two minutes.</span></li>
        <li><span class="step-num">02</span><span><strong>Free walkthrough</strong>We measure and listen.</span></li>
        <li><span class="step-num">03</span><span><strong>Written quote</strong>Within five business days.</span></li>
      </ol>
      <p class="hours">Office hours Monday to Friday, 7 am to 5 pm. Free estimates within 25 miles.</p>
    </div>
    <div class="card form-card">
      <h2 id="estimate-title">Request a free estimate</h2>
      ${formNote(rc)}
      ${errorSummary(errors)}
      <form method="post" action="/estimate" aria-labelledby="estimate-title" novalidate>
        ${hiddenFields(rc, { honeypot: true })}
        ${input({ name: "name", label: "Your name", values, errors, required: true, max: LIMITS.name, autocomplete: "name" })}
        <div class="field-row">
          ${input({ name: "email", label: "Email", type: "email", values, errors, required: true, max: LIMITS.email, autocomplete: "email" })}
          ${input({ name: "phone", label: "Phone", type: "tel", values, errors, max: LIMITS.phone, autocomplete: "tel", optional: true })}
        </div>
        ${select({ name: "project", label: "Project", options: PROJECTS, values, errors, placeholder: "Choose one" })}
        <div class="field-row">
          ${select({ name: "budget", label: "Budget", options: BUDGETS, values, errors, placeholder: "Choose a range" })}
          ${select({ name: "timeline", label: "When to start", options: TIMELINES, values, errors, placeholder: "Choose one" })}
        </div>
        ${textarea({ name: "details", label: "About the project", values, errors, max: LIMITS.details, rows: 4, required: true, placeholder: "What you'd like done, the size of the space, anything we should know." })}
        <button class="button button-primary button-block" type="submit">Send my request</button>
      </form>
    </div>
  </div>
</section>`;
  return layout(rc, { title: "Request a free estimate", body });
}

export function thanksPage(rc) {
  // In the demo, only a visitor who has saved something has a demo link (rc.key).
  const demoText = rc.key
    ? `Your request is on the owner's lead board now, next to some sample leads. It shows only on your demo link, so anyone you share that link with can see it too.`
    : `Open the lead board to see sample leads and how the owner keeps track of them.`;
  const demoNext = rc.demo
    ? `<div class="callout"><h2>See it from the owner's side</h2><p>${demoText}</p><a class="button button-primary" href="${rc.href("/admin")}">Open the lead board</a></div>`
    : "";
  const lede = rc.demo
    ? "In the real app, a crew lead would call or email within one business day. This is a demo, so nobody will contact you."
    : "A crew lead will call or email within one business day to set up a free walkthrough.";
  const body = `
<section class="wrap narrow">
  <div class="card thanks">
    <p class="eyebrow">Request received</p>
    <h1>Thanks. Your request is in.</h1>
    <p class="lede">${lede}</p>
    <h2 class="small-head">What happens next</h2>
    <ol class="next-steps">
      <li>We read your notes and call you back to ask a few questions.</li>
      <li>We visit, measure, and talk through options and budget.</li>
      <li>You get a written, line-item quote within five business days.</li>
    </ol>
    ${demoNext}
    <p><a class="text-link" href="${rc.href("/")}">${ICON.back} Back to the home page</a></p>
  </div>
</section>`;
  return layout(rc, { title: "Request received", body });
}

// ---------------------------------------------------------------------------
// Owner pages
// ---------------------------------------------------------------------------

function statTile(label, value, note, tone = "") {
  return `<div class="stat ${tone}"><p class="stat-label">${escapeHtml(label)}</p><p class="stat-value">${value}</p><p class="stat-note">${escapeHtml(note)}</p></div>`;
}

function followDate(value) {
  return shortDate.format(new Date(`${value}T12:00:00Z`));
}

/** One line of history. With a lead link for the board feed, without on the lead page. */
function activityLine(entry, leadLink) {
  const stage = `<strong>${escapeHtml(labelFor(STAGES, entry.stage))}</strong>`;
  if (leadLink) {
    switch (entry.kind) {
      case "received":
        return `${leadLink} sent a request from the website`;
      case "added":
        return `${leadLink} was added to the board`;
      case "stage":
        return `${leadLink} moved to ${stage}`;
      case "follow_up":
        return entry.body ? `Follow-up with ${leadLink} set for <strong>${escapeHtml(followDate(entry.body))}</strong>` : `Follow-up with ${leadLink} cleared`;
      default:
        return `Note on ${leadLink}`;
    }
  }
  switch (entry.kind) {
    case "received":
      return "Request received from the website";
    case "added":
      return "Added to the board";
    case "stage":
      return `Moved to ${stage}`;
    case "follow_up":
      return entry.body ? `Follow-up set for <strong>${escapeHtml(followDate(entry.body))}</strong>` : "Follow-up cleared";
    default:
      return "Note";
  }
}

function activityFeed(rc, entries, now, { showLead }) {
  if (entries.length === 0) return `<p class="empty">Nothing yet.</p>`;
  const items = entries.map((entry) => {
    const leadLink = showLead ? `<a href="${rc.href(`/admin/leads/${encodeURIComponent(entry.lead_id)}`)}">${escapeHtml(entry.lead_name)}</a>` : "";
    // The board shows the start of each note; the lead page shows all of it.
    const noteText = showLead && entry.body.length > 90 ? `${entry.body.slice(0, 88).trimEnd()}…` : entry.body;
    const note = entry.kind === "note" ? `<p class="feed-note">${escapeHtml(noteText)}</p>` : "";
    return `<li class="feed-item is-${escapeHtml(entry.kind)}${entry.kind === "stage" ? ` is-stage-${escapeHtml(entry.stage)}` : ""}"><span class="feed-dot" aria-hidden="true"></span><div><p class="feed-line">${activityLine(entry, leadLink)}</p>${note}<p class="feed-time"><time datetime="${escapeHtml(entry.created_at)}">${escapeHtml(timeAgo(entry.created_at, now))}</time></p></div></li>`;
  });
  return `<ol class="feed">${items.join("")}</ol>`;
}

/** A board number: "12", or "100+" when there are more than were counted. */
function amount({ count, more }) {
  return `${count}${more ? "+" : ""}`;
}

export function boardPage(rc, { leads, cursor = "", after = "", summary, activity, stage, now, saved = "" }) {
  const tabs = [{ value: "", label: "All", count: summary.total }, ...STAGES.map((option) => ({ ...option, count: summary.counts[option.value] }))]
    .map((tab) => {
      const href = rc.href(tab.value ? `/admin?stage=${tab.value}` : "/admin");
      const current = tab.value === stage;
      return `<li><a class="tab${tab.value ? ` tab-${tab.value}` : ""}" href="${href}"${current ? ' aria-current="page"' : ""}>${escapeHtml(tab.label)}<span class="tab-count">${amount(tab.count)}</span></a></li>`;
    })
    .join("");

  const rows = leads
    .map((lead) => {
      const followLabel = followUpLabel(lead.follow_up_on, now);
      const due = isDue(lead, now);
      const follow = OPEN_STAGES.has(lead.stage) && followLabel ? `<span class="follow${due ? " is-due" : ""}">${due ? ICON.flag : ""}${escapeHtml(followLabel)}</span>` : `<span class="muted">None</span>`;
      return `<tr>
<td class="cell-lead" data-label="Lead"><a class="lead-link" href="${rc.href(`/admin/leads/${encodeURIComponent(lead.id)}`)}">${escapeHtml(lead.name)}</a><span class="lead-meta">${escapeHtml(labelFor(PROJECTS, lead.project))} · ${escapeHtml(labelFor(BUDGETS, lead.budget))}</span></td>
<td class="cell-stage" data-label="Stage">${stageChip(lead.stage)}</td>
<td class="cell-follow" data-label="Follow up">${follow}</td>
<td class="cell-source" data-label="Source">${escapeHtml(labelFor(SOURCES, lead.source))}</td>
<td class="cell-received" data-label="Received"><time datetime="${escapeHtml(lead.received_at)}">${escapeHtml(timeAgo(lead.received_at, now))}</time></td>
</tr>`;
    })
    .join("");

  const stageQuery = stage ? `stage=${stage}&` : "";
  const pager = [
    after ? `<a class="text-link" href="${escapeHtml(rc.href(stage ? `/admin?stage=${stage}` : "/admin"))}">${ICON.back} Newest leads</a>` : "",
    cursor ? `<a class="button" href="${escapeHtml(rc.href(`/admin?${stageQuery}after=${encodeURIComponent(cursor)}`))}">Older leads</a>` : ""
  ].filter(Boolean);
  const pagerNav = pager.length ? `<nav class="form-actions pager" aria-label="More leads">${pager.join("")}</nav>` : "";

  const stageWord = stage ? `${escapeHtml(labelFor(STAGES, stage).toLowerCase())} ` : "";
  const table = leads.length
    ? `<table class="leads"><caption class="visually-hidden">${escapeHtml(stage ? `${labelFor(STAGES, stage)} leads` : "All leads")}, newest first</caption><thead><tr><th scope="col">Lead</th><th scope="col">Stage</th><th scope="col">Follow up</th><th scope="col" class="cell-source">Source</th><th scope="col">Received</th></tr></thead><tbody>${rows}</tbody></table>`
    : after
      ? `<div class="empty-state"><p>No older ${stageWord}leads.</p></div>`
      : `<div class="empty-state"><p>No ${stageWord}leads right now.</p><a class="button" href="${rc.href("/admin/leads/new")}">Add a lead</a></div>`;

  const flash = saved === "deleted" ? `<p class="flash" role="status">${ICON.check}Lead deleted.</p>` : "";
  const newCount = summary.counts.new;
  const body = `
<div class="wrap owner-wrap">
  ${flash}
  <div class="page-head">
    <div><h1>Leads</h1><p class="page-sub">${amount(summary.open)} open · ${amount(summary.total)} total</p></div>
    <a class="button button-primary" href="${rc.href("/admin/leads/new")}">${ICON.plus}Add a lead</a>
  </div>
  <div class="stats">
    ${statTile("New", amount(newCount), "Waiting for a first call", newCount.count ? "tone-new" : "")}
    ${statTile("Follow-ups due", amount(summary.due), "Today or overdue", summary.due.count ? "tone-due" : "")}
    ${statTile("Open jobs", amount(summary.open), "New through quoted")}
    ${statTile("This week", amount(summary.thisWeek), "Leads received")}
  </div>
  <div class="board-grid">
    <section class="board-main" aria-labelledby="leads-title">
      <h2 id="leads-title" class="visually-hidden">Lead list</h2>
      <nav aria-label="Filter by stage"><ul class="tabs">${tabs}</ul></nav>
      <div class="card table-card">${table}</div>
      ${pagerNav}
    </section>
    <aside class="board-side card" aria-labelledby="activity-title">
      <h2 id="activity-title" class="side-title">Recent activity</h2>
      ${activityFeed(rc, activity, now, { showLead: true })}
    </aside>
  </div>
</div>`;
  return layout(rc, { title: stage ? `${labelFor(STAGES, stage)} leads` : "Leads", area: "owner", body });
}

export function newLeadPage(rc, { values = {}, errors = {} } = {}) {
  const body = `
<div class="wrap owner-wrap narrow">
  <p class="crumb"><a class="text-link" href="${rc.href("/admin")}">${ICON.back} All leads</a></p>
  <div class="card form-card">
    <h1 id="new-title">Add a lead</h1>
    <p class="card-sub">For calls, referrals, and walk-ins. Website requests show up on their own.</p>
    ${errorSummary(errors)}
    <form method="post" action="/admin/leads" aria-labelledby="new-title" novalidate>
      ${hiddenFields(rc)}
      ${input({ name: "name", label: "Name", values, errors, required: true, max: LIMITS.name, autocomplete: "off" })}
      <div class="field-row">
        ${input({ name: "email", label: "Email", type: "email", values, errors, max: LIMITS.email, autocomplete: "off" })}
        ${input({ name: "phone", label: "Phone", type: "tel", values, errors, max: LIMITS.phone, autocomplete: "off" })}
      </div>
      <div class="field-row">
        ${select({ name: "project", label: "Project", options: PROJECTS, values, errors, placeholder: "Choose one" })}
        ${select({ name: "budget", label: "Budget", options: BUDGETS, values, errors, placeholder: "Choose a range" })}
      </div>
      <div class="field-row">
        ${select({ name: "source", label: "Came from", options: SOURCES, values, errors, placeholder: "Choose one" })}
        ${select({ name: "timeline", label: "When to start", options: TIMELINES, values, errors, placeholder: "Not sure", required: false, optional: true })}
      </div>
      ${textarea({ name: "details", label: "Project notes", values, errors, max: LIMITS.details, rows: 4 })}
      <div class="form-actions"><button class="button button-primary" type="submit">Add lead</button><a class="text-link" href="${rc.href("/admin")}">Cancel</a></div>
    </form>
  </div>
</div>`;
  return layout(rc, { title: "Add a lead", area: "owner", body });
}

export function leadPage(rc, { lead, history, now, updateErrors = {}, noteErrors = {}, noteValues = {}, deleteErrors = {}, saved = "" }) {
  const stageOptions = STAGES.map(
    (option) =>
      `<label class="stage-option stage-${option.value}"><input type="radio" name="stage" value="${option.value}"${lead.stage === option.value ? " checked" : ""}><span>${escapeHtml(option.label)}</span></label>`
  ).join("");
  const savedMessages = {
    update: "Lead updated.",
    note: "Note saved.",
    created: "Lead added.",
    deleting: "Part of this lead's history was removed. Press Delete lead again to finish."
  };
  const savedMessage = savedMessages[saved] ?? "";
  const olderNote = history.more ? `<p class="hint">Showing the latest ${history.entries.length} entries.</p>` : "";
  const contact = [
    lead.email ? `<a href="${escapeHtml(mailtoHref(lead.email))}">${escapeHtml(lead.email)}</a>` : "",
    lead.phone ? `<a href="tel:${escapeHtml(lead.phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(lead.phone)}</a>` : ""
  ]
    .filter(Boolean)
    .join("");
  const body = `
<div class="wrap owner-wrap">
  <p class="crumb"><a class="text-link" href="${rc.href("/admin")}">${ICON.back} All leads</a></p>
  ${savedMessage ? `<p class="flash" role="status">${ICON.check}${escapeHtml(savedMessage)}</p>` : ""}
  <div class="page-head lead-head">
    <div><h1>${escapeHtml(lead.name)}</h1><p class="page-sub">${escapeHtml(labelFor(PROJECTS, lead.project))} · received ${escapeHtml(timeAgo(lead.received_at, now).toLowerCase())} · ${escapeHtml(labelFor(SOURCES, lead.source))}</p></div>
    ${stageChip(lead.stage)}
  </div>
  <div class="lead-grid">
    <div class="lead-main">
      <section class="card card-project" aria-labelledby="project-title">
        <h2 id="project-title" class="side-title">Project</h2>
        <dl class="facts">
          <div><dt>Type</dt><dd>${escapeHtml(labelFor(PROJECTS, lead.project))}</dd></div>
          <div><dt>Budget</dt><dd>${escapeHtml(labelFor(BUDGETS, lead.budget))}</dd></div>
          <div><dt>Start</dt><dd>${escapeHtml(labelFor(TIMELINES, lead.timeline) || "Not given")}</dd></div>
          <div class="fact-contact"><dt>Contact</dt><dd class="contact">${contact || "None"}</dd></div>
        </dl>
        ${lead.details ? `<p class="details">${escapeHtml(lead.details)}</p>` : ""}
      </section>
      <section class="card card-history" aria-labelledby="history-title">
        <h2 id="history-title" class="side-title">History</h2>
        ${activityFeed(rc, history.entries, now, { showLead: false })}
        ${olderNote}
      </section>
    </div>
    <div class="lead-side">
      <section class="card card-update" aria-labelledby="update-title">
        <h2 id="update-title" class="side-title">Update lead</h2>
        ${errorSummary(updateErrors)}
        <form method="post" action="/admin/leads/${encodeURIComponent(lead.id)}/stage" novalidate>
          ${hiddenFields(rc)}
          <fieldset class="stage-picker" id="stage"${updateErrors.stage ? ' aria-invalid="true"' : ""}><legend>Stage</legend><div class="stage-options">${stageOptions}</div></fieldset>
          ${input({ name: "follow_up_on", label: "Follow up on", type: "date", values: lead, errors: updateErrors, hint: "Leave blank for no follow-up.", optional: true })}
          <button class="button button-primary button-block" type="submit">Save changes</button>
        </form>
      </section>
      <section class="card card-note" aria-labelledby="note-title">
        <h2 id="note-title" class="side-title">Add a note</h2>
        ${errorSummary(noteErrors)}
        <form method="post" action="/admin/leads/${encodeURIComponent(lead.id)}/notes" novalidate>
          ${hiddenFields(rc)}
          ${textarea({ name: "body", label: "Note", values: noteValues, errors: noteErrors, max: LIMITS.note, rows: 3, required: true, placeholder: "Call summary, measurements, quote details..." })}
          <button class="button button-block" type="submit">Save note</button>
        </form>
      </section>
      <section class="card card-delete" aria-labelledby="delete-title">
        <h2 id="delete-title" class="side-title">Delete lead</h2>
        <p class="hint">For spam and test entries. This removes the lead and its history for good.</p>
        ${errorSummary(deleteErrors)}
        <form method="post" action="/admin/leads/${encodeURIComponent(lead.id)}/delete" novalidate>
          ${hiddenFields(rc)}
          <div class="field"><label class="check"><input id="confirm" type="checkbox" name="confirm" value="yes"${deleteErrors.confirm ? ' aria-invalid="true" aria-describedby="confirm-error"' : ""}> Yes, delete ${escapeHtml(lead.name)} and their history</label>${fieldError("confirm", deleteErrors)}</div>
          <button class="button button-block button-danger" type="submit">Delete lead</button>
        </form>
      </section>
    </div>
  </div>
</div>`;
  return layout(rc, { title: lead.name, area: "owner", body });
}

export function messagePage(rc, { title, message, area = "public", action }) {
  const body = `
<section class="wrap narrow">
  <div class="card thanks">
    <h1>${escapeHtml(title)}</h1>
    <p class="lede">${escapeHtml(message)}</p>
    ${action ? `<p><a class="button button-primary" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : ""}
  </div>
</section>`;
  return layout(rc, { title, area, body });
}

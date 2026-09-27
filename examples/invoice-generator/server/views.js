// Server-rendered HTML for every page. Every value from a form or the database
// goes through esc() before it reaches the page.
//
// `rc` is the request context built in index.js:
//   rc.link(path)      app path for a link or form action
//   rc.robots          robots meta value, or null
//   rc.banner(section) and rc.footer   extra page chrome (empty outside the demo)
//   rc.signOut         show a sign-out link on desk pages

import { STUDIO } from "./studio.js";
import { LIMITS, allowedTransitions, canConvert, isEditable, isOverdue, parseMoney, parsePercent, parseQuantity, today } from "./store.js";

// ---------------------------------------------------------------------------
// Formatting

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const money = new Intl.NumberFormat(STUDIO.locale, { style: "currency", currency: STUDIO.currency });
const amount = new Intl.NumberFormat(STUDIO.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat(STUDIO.locale, { maximumFractionDigits: 2 });
const shortDate = new Intl.DateTimeFormat(STUDIO.locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat(STUDIO.locale, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export const fmtMoney = (cents) => money.format((cents ?? 0) / 100);
export const fmtAmount = (cents) => amount.format((cents ?? 0) / 100);
const fmtQuantity = (value) => quantity.format(value ?? 0);
const fmtDate = (value) => (value ? shortDate.format(new Date(`${value}T00:00:00Z`)) : "");
const moneyInput = (cents) => (cents === undefined || cents === null ? "" : ((cents ?? 0) / 100).toFixed(2));
const lines = (text) => esc(text).replace(/\n/g, "<br>");
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const KIND = { quote: "Quote", invoice: "Invoice" };

const STATUS = {
  requested: "New request",
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  converted: "Invoiced",
  paid: "Paid",
  void: "Void"
};

function statusOf(document) {
  if (isOverdue(document)) return { key: "overdue", label: "Overdue" };
  return { key: document.status, label: STATUS[document.status] ?? document.status };
}

function statusTag(document) {
  const status = statusOf(document);
  return `<span class="status status-${status.key}"><span class="status-dot" aria-hidden="true"></span>${esc(status.label)}</span>`;
}

// Button labels for each status change the owner can make (see TRANSITIONS in store.js).
function actionLabel(document, to) {
  const from = document.status;
  if (to === "draft") return from === "requested" ? "Start a draft" : from === "void" ? "Restore as draft" : from === "declined" ? "Reopen as draft" : "Back to draft";
  if (to === "sent") return from === "paid" ? "Mark as unpaid" : from === "accepted" ? "Undo acceptance" : "Mark as sent";
  if (to === "accepted") return "Mark accepted";
  if (to === "declined") return from === "requested" ? "Decline request" : "Mark declined";
  if (to === "paid") return "Mark as paid";
  if (to === "void") return "Void invoice";
  return to;
}

// ---------------------------------------------------------------------------
// Brand

const MARK = `<svg class="mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false"><path class="mark-frame" d="M2 12V2h10M20 2h10v10M30 20v10H20M12 30H2V20"/><rect class="mark-dot" x="11" y="11" width="10" height="10"/></svg>`;

function wordmark(rc, section) {
  const label = section === "desk" ? `<span class="wordmark-sub">Studio desk</span>` : "";
  const href = section === "desk" ? rc.link("/desk") : rc.link("/");
  return `<a class="wordmark" href="${esc(href)}">${MARK}<span class="wordmark-name">${esc(STUDIO.name)}</span>${label}</a>`;
}

// ---------------------------------------------------------------------------
// Page shell

function page(rc, { title, section, body, description = "", robots = null }) {
  const robotsValue = rc.robots ?? robots;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ""}${robotsValue ? `<meta name="robots" content="${esc(robotsValue)}">\n` : ""}<meta name="theme-color" content="#f4f2ed">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/archivo-latin-wdth.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body class="section-${section}">
<a class="skip-link" href="#main">Skip to content</a>
${rc.banner(section)}
${section === "desk" ? deskHeader(rc) : section === "client" ? clientHeader(rc) : publicHeader(rc)}
<main id="main" tabindex="-1">
${body}
</main>
${siteFooter(rc, section)}
</body>
</html>`;
}

function publicHeader(rc) {
  return `<header class="masthead"><div class="wrap masthead-inner">${wordmark(rc, "public")}<nav class="nav" aria-label="Main"><a href="${esc(rc.link("/#services"))}">Services</a><a href="${esc(rc.link("/#process"))}">How we work</a><a class="nav-cta" href="${esc(rc.link("/#request"))}">Request a quote</a></nav></div></header>`;
}

function clientHeader(rc) {
  return `<header class="masthead"><div class="wrap masthead-inner">${wordmark(rc, "client")}<p class="masthead-note">${esc(STUDIO.email)}</p></div></header>`;
}

function deskHeader(rc) {
  const current = rc.url.pathname;
  const item = (href, label, active) => `<a href="${esc(rc.link(href))}"${active ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="masthead masthead-desk"><div class="wrap masthead-inner">${wordmark(rc, "desk")}<nav class="nav" aria-label="Studio desk">${item("/desk", "Documents", current === "/desk" || current.startsWith("/desk/documents"))}${item("/desk/clients", "Clients", current.startsWith("/desk/clients"))}<a class="nav-cta" href="${esc(rc.link("/desk/new?kind=quote"))}">New quote</a>${rc.signOut ? `<a href="/_userland/auth/logout">Sign out</a>` : ""}</nav></div></header>`;
}

function siteFooter(rc, section) {
  const studio = section === "desk" ? "" : `<p>${esc(STUDIO.name)} · ${esc(STUDIO.address.join(", "))} · <a href="mailto:${esc(STUDIO.email)}">${esc(STUDIO.email)}</a></p>`;
  return `<footer class="site-footer"><div class="wrap site-footer-inner">${studio}${rc.footer}</div></footer>`;
}

function notice(message, tone = "ok") {
  if (!message) return "";
  return `<p class="notice notice-${tone}" role="status">${esc(message)}</p>`;
}

function fieldError(errors, name) {
  return errors[name] ? `<p class="field-error" id="${name}-error">${esc(errors[name])}</p>` : "";
}

function describedBy(errors, name, hint = "") {
  const ids = [hint, errors[name] ? `${name}-error` : ""].filter(Boolean).join(" ");
  return ids ? ` aria-describedby="${ids}"${errors[name] ? ' aria-invalid="true"' : ""}` : "";
}

function errorSummary(errors) {
  const messages = Object.values(errors);
  if (messages.length === 0) return "";
  return `<div class="error-summary" role="alert" tabindex="-1"><p>Please check ${messages.length === 1 ? "this field" : "these fields"}:</p><ul>${messages.map((message) => `<li>${esc(message)}</li>`).join("")}</ul></div>`;
}

// ---------------------------------------------------------------------------
// Public pages

export function homePage(rc, { values = {}, errors = {} } = {}) {
  const services = STUDIO.services
    .map(
      (service, index) => `<li class="service"><span class="service-index">${String(index + 1).padStart(2, "0")}</span><div><h3>${esc(service.name)}</h3><p>${esc(service.detail)}</p></div><p class="service-price"><span>from</span> ${esc(fmtMoney(service.from_cents).replace(/\.00$/, ""))}</p></li>`
    )
    .join("");
  const options = STUDIO.services
    .map((service) => `<option value="${esc(service.id)}"${values.service === service.id ? " selected" : ""}>${esc(service.name)}</option>`)
    .join("");
  const body = `
<section class="hero wrap">
  <div class="hero-copy">
    <p class="eyebrow">${esc(STUDIO.tagline)} · Portland</p>
    <h1>Identity, packaging, and photography for independent brands.</h1>
    <p class="lead">Tell us about your project. You'll get a clear, itemized quote within two working days, and you can accept it online.</p>
    <dl class="facts">
      <div><dt>2 days</dt><dd>to an itemized quote</dd></div>
      <div><dt>1 click</dt><dd>to accept it online</dd></div>
      <div><dt>${STUDIO.paymentTermsDays} days</dt><dd>to pay each invoice</dd></div>
    </dl>
  </div>
  <form class="card request-form" id="request" method="post" action="${esc(rc.link("/request"))}" novalidate>
    <h2>Request a quote</h2>
    ${errorSummary(errors)}
    <div class="field"><label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="${LIMITS.name}" required value="${esc(values.name)}"${describedBy(errors, "name")}>${fieldError(errors, "name")}</div>
    <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="${LIMITS.email}" required value="${esc(values.email)}"${describedBy(errors, "email")}>${fieldError(errors, "email")}</div>
    <div class="field"><label for="company">Business name <span class="optional">optional</span></label><input id="company" name="company" autocomplete="organization" maxlength="${LIMITS.company}" value="${esc(values.company)}"${describedBy(errors, "company")}>${fieldError(errors, "company")}</div>
    <div class="field"><label for="service">What do you need?</label><select id="service" name="service" required${describedBy(errors, "service")}><option value="">Choose one</option>${options}</select>${fieldError(errors, "service")}</div>
    <div class="field"><label for="message">About the project</label><textarea id="message" name="message" rows="4" maxlength="${LIMITS.message}" required${describedBy(errors, "message", "message-hint")}>${esc(values.message)}</textarea><p class="hint" id="message-hint">Scope, timing, and anything we should know.</p>${fieldError(errors, "message")}</div>
    <div class="trap" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
    <button class="button button-primary" type="submit">Send request</button>
  </form>
</section>
<section class="band" id="services" aria-labelledby="services-title">
  <div class="wrap">
    <h2 class="section-title" id="services-title">Services</h2>
    <ol class="services">${services}</ol>
  </div>
</section>
<section class="band" id="process" aria-labelledby="process-title">
  <div class="wrap">
    <h2 class="section-title" id="process-title">How we work</h2>
    <ol class="steps">
      <li><span class="step-index">1</span><h3>Request</h3><p>Send a few lines about the project. No calls needed to get started.</p></li>
      <li><span class="step-index">2</span><h3>Quote</h3><p>We send an itemized quote with a private link. Accept it with one click.</p></li>
      <li><span class="step-index">3</span><h3>Invoice</h3><p>When the work is done, the same link shows your invoice, ready to print.</p></li>
    </ol>
  </div>
</section>`;
  return page(rc, {
    title: `${STUDIO.name} · ${STUDIO.tagline}`,
    section: "public",
    description: "Identity, packaging, and photography for independent brands. Request a quote and get an itemized estimate within two working days.",
    body
  });
}

export function requestSentPage(rc, { deskHref }) {
  const body = `
<section class="wrap narrow confirm">
  <p class="eyebrow">Request received</p>
  <h1>Thanks, your request is in.</h1>
  <p class="lead">We'll read your note and reply with an itemized quote within two working days. The quote arrives as a private link you can accept online.</p>
  ${deskHref ? `<div class="card demo-next"><h2>See the other side</h2><p>Your request is waiting in the studio desk. Price it, send it, and turn it into an invoice.</p><a class="button button-primary" href="${esc(deskHref)}">Open the studio desk</a></div>` : `<p><a href="${esc(rc.link("/"))}">Back to the studio</a></p>`}
</section>`;
  return page(rc, { title: `Request received · ${STUDIO.name}`, section: "public", body, robots: "noindex,nofollow" });
}

// The private client view of a quote or invoice: /p/:token
export function clientDocumentPage(rc, { document, client, deskHref = null, flash = "" }) {
  const answer =
    document.kind === "quote" && document.status === "sent"
      ? `<form class="respond" method="post" action="${esc(rc.link(`/p/${document.public_token}/respond`))}"><p>Happy with this quote? Accepting it books the work. We'll confirm dates by email.</p><div class="button-row"><button class="button button-primary" name="answer" value="accept" type="submit">Accept quote</button><button class="button button-quiet" name="answer" value="decline" type="submit">Decline</button></div></form>`
      : "";
  const body = `
<div class="wrap doc-wrap">
  <div class="doc-toolbar no-print">
    ${deskHref ? `<a class="back" href="${esc(deskHref)}">Back to the studio desk</a>` : `<span></span>`}
    <button class="button button-quiet" type="button" data-print>Print or save as PDF</button>
  </div>
  ${notice(flash)}
  ${answer}
  ${sheet(document, client)}
</div>`;
  return page(rc, { title: `${KIND[document.kind]} ${document.number} · ${STUDIO.name}`, section: "client", body, robots: "noindex,nofollow" });
}

// ---------------------------------------------------------------------------
// The printable document. Used by the desk and by the client link.

function sheet(document, client) {
  const isQuote = document.kind === "quote";
  const status = statusOf(document);
  const stamp =
    status.key === "paid"
      ? `Paid ${fmtDate(document.paid_on)}`
      : status.key === "overdue"
        ? `Overdue since ${fmtDate(document.due_date)}`
        : status.key === "accepted" || status.key === "converted"
          ? `Accepted ${fmtDate(document.accepted_on)}`
          : status.key === "void"
            ? "Void"
            : status.key === "declined"
              ? "Declined"
              : "";
  const rows = (document.line_items ?? [])
    .map(
      (item) => `<tr><td class="col-desc">${esc(item.description)}<span class="line-meta" aria-hidden="true">${fmtQuantity(item.quantity)} × ${fmtAmount(item.unit_cents)}</span></td><td class="num col-qty">${fmtQuantity(item.quantity)}</td><td class="num col-rate">${fmtAmount(item.unit_cents)}</td><td class="num col-amount">${fmtAmount(item.amount_cents)}</td></tr>`
    )
    .join("");
  const tax = document.tax_cents > 0 || document.tax_percent > 0 ? `<tr><th scope="row" colspan="3">Tax ${fmtQuantity(document.tax_percent)}%</th><td class="num">${fmtAmount(document.tax_cents)}</td></tr>` : "";
  const items =
    rows === ""
      ? `<div class="sheet-empty"><p><strong>Not priced yet.</strong></p>${document.request_message ? `<p class="request-quote">“${lines(document.request_message)}”</p>` : ""}</div>`
      : `<table class="lines">
  <caption class="visually-hidden">Line items</caption>
  <thead><tr><th scope="col" class="col-desc">Description</th><th scope="col" class="num col-qty">Qty</th><th scope="col" class="num col-rate">Rate</th><th scope="col" class="num col-amount">Amount</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr class="subtotal"><th scope="row" colspan="3">Subtotal</th><td class="num">${fmtAmount(document.subtotal_cents)}</td></tr>
    ${tax}
    <tr class="total"><th scope="row" colspan="3">${isQuote ? "Total" : "Total due"} <span class="currency">${esc(document.currency)}</span></th><td class="num">${fmtMoney(document.total_cents)}</td></tr>
  </tfoot>
</table>`;
  const who = client
    ? `<p><strong>${esc(client.name)}</strong>${client.company ? `<br>${esc(client.company)}` : ""}${client.address ? `<br>${lines(client.address)}` : ""}<br>${esc(client.email)}</p>`
    : `<p>Client removed</p>`;
  return `<article class="sheet" aria-labelledby="sheet-${esc(document.id)}">
  <header class="sheet-head">
    <div class="sheet-brand">${MARK}<div><p class="sheet-studio">${esc(STUDIO.name)}</p><p class="sheet-from">${STUDIO.address.map(esc).join("<br>")}<br>${esc(STUDIO.email)}</p></div></div>
    <div class="sheet-kind"><h1 id="sheet-${esc(document.id)}">${KIND[document.kind]}</h1><p class="sheet-number">${esc(document.number)}</p>${stamp ? `<p class="stamp stamp-${status.key}">${esc(stamp)}</p>` : ""}</div>
  </header>
  <div class="sheet-meta">
    <div><h2>${isQuote ? "Prepared for" : "Billed to"}</h2>${who}</div>
    <div><h2>Project</h2><p class="sheet-project">${esc(document.title)}</p></div>
    <dl class="sheet-dates">
      <div><dt>${isQuote ? "Date" : "Issued"}</dt><dd>${fmtDate(document.issue_date) || "Not set"}</dd></div>
      <div><dt>${isQuote ? "Valid until" : "Due"}</dt><dd>${fmtDate(document.due_date) || "Not set"}</dd></div>
      <div><dt>Amount</dt><dd class="num">${fmtMoney(document.total_cents)}</dd></div>
    </dl>
  </div>
  ${items}
  ${document.notes ? `<div class="sheet-notes"><h2>${isQuote ? "Terms" : "Payment"}</h2><p>${lines(document.notes)}</p></div>` : ""}
  <footer class="sheet-foot"><span>${esc(STUDIO.name)}</span><span>${esc(STUDIO.website)}</span><span>${esc(STUDIO.email)}</span></footer>
</article>`;
}

// ---------------------------------------------------------------------------
// Studio desk

function ledger(rc, documents, clientsById, { showClient = true } = {}) {
  if (documents.length === 0) return `<p class="empty">Nothing here yet.</p>`;
  const rows = documents
    .map((document) => {
      const client = clientsById.get(document.client_id);
      const href = esc(rc.link(`/desk/documents/${document.id}`));
      return `<tr>
  <td class="col-no"><a href="${href}">${esc(document.number)}</a><span class="kind-label">${KIND[document.kind]}</span></td>
  ${showClient ? `<td class="col-client"><span class="client-name">${esc(client?.company || client?.name || "Client removed")}</span><span class="project">${esc(document.title)}</span></td>` : `<td class="col-client"><span class="client-name">${esc(document.title)}</span></td>`}
  <td class="col-date">${fmtDate(document.issue_date) || "—"}</td>
  <td class="col-date">${fmtDate(document.due_date) || "—"}</td>
  <td class="col-status">${statusTag(document)}</td>
  <td class="num col-total">${document.line_items?.length ? fmtAmount(document.total_cents) : "—"}</td>
</tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table class="ledger">
  <thead><tr><th scope="col" class="col-no">No.</th><th scope="col" class="col-client">${showClient ? "Client and project" : "Project"}</th><th scope="col" class="col-date">Issued</th><th scope="col" class="col-date">Due</th><th scope="col" class="col-status">Status</th><th scope="col" class="num col-total">Amount</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

const VIEWS = [
  ["all", "All"],
  ["quotes", "Quotes"],
  ["invoices", "Invoices"],
  ["requests", "Requests"]
];

export function deskPage(rc, { documents, clients, view, summary, flash }) {
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const shown = documents.filter((document) =>
    view === "quotes" ? document.kind === "quote" && document.status !== "requested" : view === "invoices" ? document.kind === "invoice" : view === "requests" ? document.status === "requested" : true
  );
  const tabs = VIEWS.map(([key, label]) => {
    const count = key === "requests" && summary.requests ? ` <span class="count">${summary.requests}</span>` : "";
    return `<a href="${esc(rc.link(key === "all" ? "/desk" : `/desk?view=${key}`))}"${view === key ? ' aria-current="page"' : ""}>${label}${count}</a>`;
  }).join("");
  const figure = (label, data, detail, tone = "") =>
    `<div class="figure${tone ? ` figure-${tone}` : ""}"><dt>${label}</dt><dd><span class="figure-value">${fmtMoney(data.cents)}</span><span class="figure-detail">${detail}</span></dd></div>`;
  const requests = documents.filter((document) => document.status === "requested");
  const inbox = requests.length
    ? `<section class="inbox" aria-labelledby="inbox-title"><h2 id="inbox-title">${plural(requests.length, "new quote request", "new quote requests")}</h2><ul>${requests
        .map((document) => {
          const client = clientsById.get(document.client_id);
          return `<li><p><strong>${esc(client?.name ?? "Unknown")}</strong>${client?.company ? `, ${esc(client.company)}` : ""}<span class="project">${esc(document.title)}</span></p><a class="button button-primary button-small" href="${esc(rc.link(`/desk/documents/${document.id}/edit`))}">Price it</a></li>`;
        })
        .join("")}</ul></section>`
    : "";
  const body = `
<div class="wrap desk">
  <div class="desk-head">
    <div><p class="eyebrow">${longDate.format(new Date(`${today()}T00:00:00Z`))}</p><h1>Quotes and invoices</h1></div>
    <div class="button-row"><a class="button button-primary" href="${esc(rc.link("/desk/new?kind=quote"))}">New quote</a><a class="button" href="${esc(rc.link("/desk/new?kind=invoice"))}">New invoice</a></div>
  </div>
  ${notice(flash)}
  <dl class="figures">
    ${figure("Outstanding", summary.outstanding, plural(summary.outstanding.count, "invoice", "invoices"))}
    ${figure("Overdue", summary.overdue, plural(summary.overdue.count, "invoice", "invoices"), summary.overdue.count ? "alert" : "")}
    ${figure("Open quotes", summary.openQuotes, plural(summary.openQuotes.count, "quote", "quotes"))}
    ${figure("Paid, last 30 days", summary.paid30, plural(summary.paid30.count, "invoice", "invoices"))}
  </dl>
  ${inbox}
  <nav class="tabs" aria-label="Filter documents">${tabs}</nav>
  ${ledger(rc, shown, clientsById)}
</div>`;
  return page(rc, { title: `Quotes and invoices · ${STUDIO.name}`, section: "desk", body, robots: "noindex,nofollow" });
}

export function documentPage(rc, { document, client, related, clientUrl, clientViewHref, flash, error }) {
  const transitions = allowedTransitions(document);
  const primary = document.status === "requested" ? null : transitions[0];
  const statusButtons = transitions
    .map(
      (to) =>
        `<button class="button${to === primary && !canConvert(document) ? " button-primary" : ""}" name="status" value="${esc(to)}" type="submit">${esc(actionLabel(document, to))}</button>`
    )
    .join("");
  const editLink = isEditable(document)
    ? `<a class="button${document.status === "requested" ? " button-primary" : ""}" href="${esc(rc.link(`/desk/documents/${document.id}/edit`))}">${document.status === "requested" ? "Price this request" : "Edit"}</a>`
    : "";
  const convert = canConvert(document)
    ? `<form method="post" action="${esc(rc.link(`/desk/documents/${document.id}/convert`))}"><button class="button button-primary" type="submit">Create invoice from quote</button></form>`
    : "";
  const share = clientUrl
    ? `<div class="panel-block"><h2>Client link</h2><p>Send this private link from your own email. Your client can view${document.kind === "quote" && document.status === "sent" ? ", accept," : ""} and print it.</p><div class="copy-field"><label class="visually-hidden" for="client-link">Client link</label><input id="client-link" readonly value="${esc(clientUrl)}"><button class="button button-small" type="button" data-copy="#client-link">Copy</button></div><p class="copy-status" role="status" aria-live="polite"></p><a href="${esc(clientViewHref)}">Open the client view</a></div>`
    : `<div class="panel-block"><h2>Client link</h2><p>The private link for your client works once you mark this ${document.kind} as sent.</p></div>`;
  const link = related
    ? `<p class="related">${related.kind === "invoice" ? "Invoiced as" : "Created from quote"} <a href="${esc(rc.link(`/desk/documents/${related.id}`))}">${esc(related.number)}</a></p>`
    : "";
  const request = document.request_message
    ? `<div class="panel-block"><h2>Client's request</h2><p class="request-quote">“${lines(document.request_message)}”</p></div>`
    : "";
  const dates = [
    ["Sent", document.sent_on],
    ["Accepted", document.accepted_on],
    ["Paid", document.paid_on]
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${fmtDate(value)}</dd></div>`)
    .join("");
  const body = `
<div class="wrap doc-wrap doc-desk">
  <div class="doc-toolbar no-print">
    <a class="back" href="${esc(rc.link(document.kind === "invoice" ? "/desk?view=invoices" : "/desk?view=quotes"))}">All ${document.kind}s</a>
    <button class="button button-quiet" type="button" data-print>Print or save as PDF</button>
  </div>
  ${notice(flash)}${notice(error, "error")}
  <div class="doc-layout">
    ${sheet(document, client)}
    <aside class="panel no-print" aria-label="${KIND[document.kind]} actions">
      <div class="panel-block panel-status"><h2>Status</h2><p>${statusTag(document)}</p>${dates ? `<dl class="panel-dates">${dates}</dl>` : ""}${link}</div>
      ${request}
      ${convert || statusButtons || editLink ? `<div class="panel-block"><h2>Next step</h2><div class="stack">${convert}${editLink}${statusButtons ? `<form method="post" action="${esc(rc.link(`/desk/documents/${document.id}/status`))}" class="stack">${statusButtons}</form>` : ""}</div></div>` : ""}
      ${share}
      ${client ? `<div class="panel-block"><h2>Client</h2><p><a href="${esc(rc.link(`/desk/clients/${client.id}`))}">${esc(client.name)}</a>${client.company ? `<br>${esc(client.company)}` : ""}</p></div>` : ""}
    </aside>
  </div>
</div>`;
  return page(rc, { title: `${KIND[document.kind]} ${document.number} · ${STUDIO.name}`, section: "desk", body, robots: "noindex,nofollow" });
}

export function documentFormPage(rc, { kind, document = null, clients, values = {}, errors = {}, requestMessage = "", extraRow = false }) {
  const isQuote = kind === "quote";
  const editing = Boolean(document);
  const action = editing ? `/desk/documents/${document.id}` : "/desk/documents";
  const heading = editing ? (document.status === "requested" ? `Price request ${document.number}` : `Edit ${document.number}`) : `New ${kind}`;
  const headingHtml = editing ? `${document.status === "requested" ? "Price request" : "Edit"} <span class="nowrap">${esc(document.number)}</span>` : esc(heading);
  const rows = values.rows?.length ? values.rows : [];
  const blanks = Math.min(LIMITS.lines - rows.length, Math.max(0, Math.max(3, rows.length + 1) - rows.length) + (extraRow ? 1 : 0));
  const allRows = [...rows, ...Array.from({ length: blanks }, () => ({ description: "", quantity: "1", rate: "" }))];
  // Amounts shown before any script runs, so the page doesn't shift when it does.
  let subtotal = 0;
  const amounts = allRows.map((row) => {
    const qty = parseQuantity(row.quantity || "1");
    const unit = parseMoney(row.rate);
    if (qty === null || unit === null || row.rate === "") return null;
    const cents = Math.round(qty * unit);
    subtotal += cents;
    return fmtAmount(cents);
  });
  const taxCents = Math.round((subtotal * (parsePercent(values.tax_percent ?? "") ?? 0)) / 100);
  const lineRow = (row, index) => `<tr class="line-row">
  <td class="col-desc"><label class="visually-hidden" for="item-description-${index}">Line ${index + 1} description</label><input id="item-description-${index}" name="item_description" maxlength="${LIMITS.lineDescription}" value="${esc(row.description)}" placeholder="What you'll deliver"></td>
  <td class="col-qty"><label class="visually-hidden" for="item-quantity-${index}">Line ${index + 1} quantity</label><input id="item-quantity-${index}" name="item_quantity" inputmode="decimal" value="${esc(row.quantity || "1")}"></td>
  <td class="col-rate"><label class="visually-hidden" for="item-rate-${index}">Line ${index + 1} price</label><input id="item-rate-${index}" name="item_rate" inputmode="decimal" value="${esc(row.rate)}" placeholder="0.00"></td>
  <td class="num col-amount"><output data-line-amount${amounts[index] === null ? " data-empty" : ""}>${amounts[index] ?? fmtAmount(0)}</output></td>
</tr>`;
  const clientOptions = clients
    .map((client) => `<option value="${esc(client.id)}"${values.client_id === client.id ? " selected" : ""}>${esc(client.name)}${client.company ? ` · ${esc(client.company)}` : ""}</option>`)
    .join("");
  const body = `
<div class="wrap narrow-wide">
  <div class="doc-toolbar"><a class="back" href="${esc(rc.link(editing ? `/desk/documents/${document.id}` : "/desk"))}">${editing ? `Back to ${document.number}` : "All documents"}</a></div>
  <h1>${headingHtml}</h1>
  ${requestMessage ? `<div class="card request-card"><h2>What the client asked for</h2><p class="request-quote">“${lines(requestMessage)}”</p></div>` : ""}
  <form class="card doc-form" method="post" action="${esc(rc.link(action))}" novalidate data-line-form data-locale="${esc(STUDIO.locale)}" data-currency="${esc(STUDIO.currency)}">
    <input type="hidden" name="kind" value="${esc(kind)}">
    <button class="visually-hidden" type="submit" tabindex="-1" aria-hidden="true">Save draft</button>
    ${errorSummary(errors)}
    <div class="form-grid">
      <div class="field span-2"><label for="client_id">Client</label>${
        clients.length
          ? `<select id="client_id" name="client_id" required${describedBy(errors, "client_id")}><option value="">Choose a client</option>${clientOptions}</select>`
          : `<p class="hint">Add a client first.</p>`
      }${fieldError(errors, "client_id")}<p class="hint"><a href="${esc(rc.link("/desk/clients#new-client"))}">Add a new client</a></p></div>
      <div class="field span-2"><label for="title">Project</label><input id="title" name="title" maxlength="${LIMITS.title}" required value="${esc(values.title)}" placeholder="Spring catalog photography"${describedBy(errors, "title")}>${fieldError(errors, "title")}</div>
      <div class="field"><label for="issue_date">${isQuote ? "Date" : "Issue date"}</label><input id="issue_date" name="issue_date" type="date" value="${esc(values.issue_date)}"${describedBy(errors, "issue_date")}>${fieldError(errors, "issue_date")}</div>
      <div class="field"><label for="due_date">${isQuote ? "Valid until" : "Due date"}</label><input id="due_date" name="due_date" type="date" value="${esc(values.due_date)}"${describedBy(errors, "due_date", "due-hint")}><p class="hint" id="due-hint">Leave empty for ${isQuote ? `${STUDIO.quoteValidDays} days` : `${STUDIO.paymentTermsDays} days`} after the ${isQuote ? "date" : "issue date"}.</p>${fieldError(errors, "due_date")}</div>
    </div>
    <fieldset class="line-items"${describedBy(errors, "line_items")}>
      <legend>Line items</legend>
      ${fieldError(errors, "line_items")}
      <div class="table-scroll"><table class="lines lines-edit">
        <thead><tr><th scope="col" class="col-desc">Description</th><th scope="col" class="col-qty">Qty</th><th scope="col" class="col-rate">Price (${esc(STUDIO.currency)})</th><th scope="col" class="num col-amount">Amount</th></tr></thead>
        <tbody data-line-body>${allRows.map(lineRow).join("")}</tbody>
      </table></div>
      ${allRows.length < LIMITS.lines ? `<button class="button button-small add-line" type="submit" name="intent" value="add-line" formnovalidate data-add-line data-max-lines="${LIMITS.lines}">Add a line</button>` : ""}
    </fieldset>
    <div class="form-grid totals-grid">
      <div class="field"><label for="tax_percent">Tax (%)</label><input id="tax_percent" name="tax_percent" inputmode="decimal" value="${esc(values.tax_percent ?? String(STUDIO.defaultTaxPercent))}"${describedBy(errors, "tax_percent")}>${fieldError(errors, "tax_percent")}</div>
      <dl class="live-totals"><div><dt>Subtotal</dt><dd class="num" data-subtotal>${fmtAmount(subtotal)}</dd></div><div><dt>Tax</dt><dd class="num" data-tax>${fmtAmount(taxCents)}</dd></div><div class="grand"><dt>Total</dt><dd class="num" data-total>${fmtMoney(subtotal + taxCents)}</dd></div></dl>
    </div>
    <div class="field notes-field"><label for="notes">${isQuote ? "Terms" : "Payment instructions"}</label><textarea id="notes" name="notes" rows="3" maxlength="${LIMITS.notes}"${describedBy(errors, "notes")}>${esc(values.notes)}</textarea>${fieldError(errors, "notes")}</div>
    <div class="button-row"><button class="button button-primary" type="submit">Save draft</button><a class="button button-quiet" href="${esc(rc.link(editing ? `/desk/documents/${document.id}` : "/desk"))}">Cancel</a></div>
  </form>
</div>`;
  return page(rc, { title: `${heading} · ${STUDIO.name}`, section: "desk", body, robots: "noindex,nofollow" });
}

/** Turns a stored document into the values the form expects. */
export function documentFormValues(document) {
  return {
    client_id: document.client_id,
    title: document.title,
    issue_date: document.issue_date,
    due_date: document.due_date,
    tax_percent: String(document.tax_percent ?? 0),
    notes: document.notes,
    rows: (document.line_items ?? []).map((item) => ({ description: item.description, quantity: String(item.quantity), rate: moneyInput(item.unit_cents) }))
  };
}

function clientFields(values, errors, prefix = "") {
  const id = (name) => `${prefix}${name}`;
  return `
    <div class="field"><label for="${id("name")}">Name</label><input id="${id("name")}" name="name" autocomplete="off" maxlength="${LIMITS.name}" required value="${esc(values.name)}"${describedBy(errors, "name")}>${fieldError(errors, "name")}</div>
    <div class="field"><label for="${id("company")}">Company <span class="optional">optional</span></label><input id="${id("company")}" name="company" maxlength="${LIMITS.company}" value="${esc(values.company)}"${describedBy(errors, "company")}>${fieldError(errors, "company")}</div>
    <div class="field"><label for="${id("email")}">Email</label><input id="${id("email")}" name="email" type="email" maxlength="${LIMITS.email}" required value="${esc(values.email)}"${describedBy(errors, "email")}>${fieldError(errors, "email")}</div>
    <div class="field"><label for="${id("address")}">Billing address <span class="optional">optional</span></label><textarea id="${id("address")}" name="address" rows="3" maxlength="${LIMITS.address}"${describedBy(errors, "address")}>${esc(values.address)}</textarea>${fieldError(errors, "address")}</div>
    <div class="field"><label for="${id("notes")}">Notes <span class="optional">only you see these</span></label><textarea id="${id("notes")}" name="notes" rows="2" maxlength="${LIMITS.clientNotes}"${describedBy(errors, "notes")}>${esc(values.notes)}</textarea>${fieldError(errors, "notes")}</div>`;
}

export function clientsPage(rc, { clients, documents, values = {}, errors = {}, flash }) {
  const rows = clients
    .map((client) => {
      const theirs = documents.filter((document) => document.client_id === client.id);
      const open = theirs.filter((document) => document.kind === "invoice" && document.status === "sent").reduce((sum, document) => sum + document.total_cents, 0);
      return `<tr><td class="col-client"><a class="client-name" href="${esc(rc.link(`/desk/clients/${client.id}`))}">${esc(client.name)}</a><span class="project">${esc(client.company)}</span></td><td class="col-email">${esc(client.email)}</td><td class="num col-count">${theirs.length}</td><td class="num col-total">${open ? fmtAmount(open) : "—"}</td></tr>`;
    })
    .join("");
  const body = `
<div class="wrap desk">
  <div class="desk-head"><div><p class="eyebrow">${plural(clients.length, "client", "clients")}</p><h1>Clients</h1></div></div>
  ${notice(flash)}
  <div class="split">
    <div>${
      clients.length
        ? `<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col" class="col-client">Client</th><th scope="col" class="col-email">Email</th><th scope="col" class="num col-count">Documents</th><th scope="col" class="num col-total">Unpaid</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="empty">No clients yet. Add your first one.</p>`
    }</div>
    <form class="card" id="new-client" method="post" action="${esc(rc.link("/desk/clients"))}" novalidate>
      <h2>Add a client</h2>
      ${errorSummary(errors)}
      ${clientFields(values, errors, "new-")}
      <button class="button button-primary" type="submit">Add client</button>
    </form>
  </div>
</div>`;
  return page(rc, { title: `Clients · ${STUDIO.name}`, section: "desk", body, robots: "noindex,nofollow" });
}

export function clientPage(rc, { client, documents, values, errors = {}, flash }) {
  const body = `
<div class="wrap desk">
  <div class="doc-toolbar"><a class="back" href="${esc(rc.link("/desk/clients"))}">All clients</a></div>
  <div class="desk-head">
    <div><p class="eyebrow">${esc(client.company || "Client")}</p><h1>${esc(client.name)}</h1></div>
    <div class="button-row"><a class="button button-primary" href="${esc(rc.link(`/desk/new?kind=quote&client=${client.id}`))}">New quote</a><a class="button" href="${esc(rc.link(`/desk/new?kind=invoice&client=${client.id}`))}">New invoice</a></div>
  </div>
  ${notice(flash)}
  <div class="split">
    <div><h2 class="section-title">Documents</h2>${ledger(rc, documents, new Map([[client.id, client]]), { showClient: false })}</div>
    <form class="card" method="post" action="${esc(rc.link(`/desk/clients/${client.id}`))}" novalidate>
      <h2>Details</h2>
      ${errorSummary(errors)}
      ${clientFields(values, errors)}
      <button class="button button-primary" type="submit">Save changes</button>
    </form>
  </div>
</div>`;
  return page(rc, { title: `${client.name} · ${STUDIO.name}`, section: "desk", body, robots: "noindex,nofollow" });
}

// ---------------------------------------------------------------------------
// Small pages

export function messagePage(rc, { title, message, section = "public", actionHtml = "" }) {
  const body = `<section class="wrap narrow confirm"><h1>${esc(title)}</h1><p class="lead">${esc(message)}</p>${actionHtml}</section>`;
  return page(rc, { title: `${title} · ${STUDIO.name}`, section, body, robots: "noindex,nofollow" });
}

export function demoStartPage(rc) {
  const body = `<section class="wrap narrow confirm"><p class="eyebrow">Studio desk</p><h1>Try the owner's side</h1><p class="lead">Open a private copy of the studio desk with sample clients, quotes, and invoices. Price a request, send a quote, and turn it into an invoice.</p><form method="post" action="/demo/start"><button class="button button-primary" type="submit">Open the studio desk</button></form></section>`;
  return page(rc, { title: `Studio desk · ${STUDIO.name}`, section: "public", body });
}

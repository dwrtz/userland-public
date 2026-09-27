// HTML for every page, rendered on the server.
//
// Pages are plain HTML and CSS with no client-side JavaScript. Every value
// that came from a visitor or the database goes through the `html` tag below,
// which escapes it, so a listing titled "<script>" shows up as text.

import { BULK_DELETE_MAX, CATEGORIES, JOB_TYPES, PAGE_ROWS, STATUS_LABELS, FIELD_LIMITS, applyHref, categoryLabel, isEmail, jobTypeLabel } from "./listings.js";

export const BRAND = {
  name: "Loamwork",
  tagline: "Farm & food jobs in the Pacific Northwest"
};

const ASSET_VERSION = "2";

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Mark a string as already-safe HTML. Only use it for markup you wrote. */
export function raw(value) {
  return new SafeHtml(String(value));
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join("");
  return escapeHtml(value);
}

/** Tagged template: interpolated values are escaped unless wrapped in raw() or html``. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let index = 0; index < values.length; index += 1) {
    out += renderValue(values[index]) + strings[index + 1];
  }
  return new SafeHtml(out);
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

export function timeAgo(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const days = Math.floor((now - time) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N}\s&]/gu, "").split(/\s+/u).filter((word) => word && word !== "&");
  return (words.slice(0, 2).map((word) => word[0]).join("") || "?").toUpperCase();
}

function paragraphs(text) {
  return String(text)
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => html`<p>${block.split("\n").map((line, index) => (index === 0 ? line : html`<br>${line}`))}</p>`);
}

// The logo mark: a sprout rising out of two furrows.
export const LOGO = raw(`<svg class="logo" viewBox="0 0 40 40" width="36" height="36" aria-hidden="true" focusable="false">
  <rect width="40" height="40" rx="11" fill="#34503A"/>
  <path d="M7 27.5c4.3-2.2 8.7-2.2 13 0s8.7 2.2 13 0" fill="none" stroke="#E7D49F" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M10 32.5c3.3-1.5 6.7-1.5 10 0s6.7 1.5 10 0" fill="none" stroke="#E7D49F" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M20 25.5V15.5" fill="none" stroke="#F4F0E4" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M20 16.5c.2-4.6 3.3-7.7 8.6-7.9-.1 5-3.4 7.9-8.6 7.9Z" fill="#B7CCA9"/>
  <path d="M20 18.5c-.2-3.9-2.9-6.6-7.3-6.8.1 4.3 2.9 6.8 7.3 6.8Z" fill="#DDE7D2"/>
</svg>`);

// Rolling fields for the board's header band.
const FIELDS_ART = raw(`<svg class="fields-art" viewBox="0 30 480 210" aria-hidden="true" focusable="false" preserveAspectRatio="xMaxYMax slice">
  <circle cx="356" cy="104" r="30" fill="#EBD9A4"/>
  <path d="M0 150C70 118 150 112 232 132s160 6 248-34v142H0Z" fill="#C3D2B5"/>
  <path d="M0 176c92-36 196-40 282-18s130 10 198-10v92H0Z" fill="#8FA784"/>
  <g fill="none" stroke="#7A9470" stroke-width="2" stroke-linecap="round" opacity=".9">
    <path d="M40 186c70-22 150-26 220-12"/>
    <path d="M70 198c64-18 140-20 204-8"/>
    <path d="M300 170c50 6 110 0 170-16"/>
  </g>
  <path d="M0 206c120-22 250-24 480-12v46H0Z" fill="#6E4F37"/>
  <g fill="none" stroke="#8C6A4E" stroke-width="2" stroke-linecap="round">
    <path d="M20 222c130-16 300-18 440-8"/>
    <path d="M60 234c120-10 260-12 380-4"/>
  </g>
  <g fill="#4E6B47">
    <path d="M118 176c0-6 3-10 9-11 0 6-3 10-9 11Z"/><path d="M118 176c0-5-3-8-7-9 0 5 3 8 7 9Z"/>
    <path d="M168 170c0-6 3-10 9-11 0 6-3 10-9 11Z"/><path d="M168 170c0-5-3-8-7-9 0 5 3 8 7 9Z"/>
    <path d="M218 168c0-6 3-10 9-11 0 6-3 10-9 11Z"/><path d="M218 168c0-5-3-8-7-9 0 5 3 8 7 9Z"/>
  </g>
</svg>`);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Wrap page content in the shared layout and return a Response.
 * `site` carries the link helper and, on the public demo, the demo notices.
 */
export function page(site, { title, description = BRAND.tagline, body, status = 200, nav = "", jsonLd = null, headers = {} }) {
  const demo = site.demo;
  const ld = jsonLd ? raw(`<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll("<", "\\u003c")}</script>`) : "";
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ${BRAND.name}` : `${BRAND.name}: ${BRAND.tagline}`}</title>
<meta name="description" content="${description}">
${demo ? demo.head : ""}
<meta name="theme-color" content="#F3EFE4">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/alegreya-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/fraunces-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/loamwork.css?v=${ASSET_VERSION}">
${ld}
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
${demo ? demo.banner : ""}
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${site.link("/")}">${LOGO}<span class="brand-text"><span class="brand-name">${BRAND.name}</span><span class="brand-tagline">${BRAND.tagline}</span></span></a>
    <nav class="site-nav" aria-label="Main">
      <a href="${site.link("/")}"${nav === "board" ? raw(' aria-current="page"') : ""}>Find work</a>
      <a href="${site.link("/post")}"${nav === "post" ? raw(' aria-current="page"') : ""}>Post a job</a>
      ${demo ? html`<a class="nav-owner" href="${site.link("/owner")}"${nav === "owner" ? raw(' aria-current="page"') : ""}>Owner view</a>` : ""}
    </nav>
  </div>
</header>
<main id="main" tabindex="-1">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <p class="footer-brand">${LOGO}<span><strong>${BRAND.name}</strong> lists jobs from farms, ranches, orchards, and food projects that care for their soil and their crews.</span></p>
    <p class="footer-links"><a href="${site.link("/post")}">Post a job</a>${demo ? "" : html` <span aria-hidden="true">·</span> <a href="/owner">Owner sign in</a>`}</p>
    ${demo ? demo.footer : ""}
  </div>
</footer>
</body>
</html>`;
  return new Response(doc.toString(), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...headers
    }
  });
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

function jobCard(site, job, now) {
  return html`<li class="job-card${job.featured ? " is-featured" : ""}">
  <span class="job-mark cat-${job.category}" aria-hidden="true">${initials(job.employer)}</span>
  <div class="job-main">
    <p class="job-employer">${job.employer} <span aria-hidden="true">·</span> ${job.location}</p>
    <h3 class="job-title"><a href="${site.link(`/jobs/${job.id}`)}">${job.title}</a></h3>
    <p class="job-summary">${job.summary}</p>
    <p class="job-tags"><span class="tag cat-${job.category}">${categoryLabel(job.category)}</span><span class="tag tag-plain">${jobTypeLabel(job.job_type)}</span>${job.featured ? html`<span class="tag tag-featured">Featured</span>` : ""}</p>
  </div>
  <div class="job-side">
    ${job.pay ? html`<p class="job-pay">${job.pay}</p>` : ""}
    <p class="job-date">Posted ${timeAgo(job.published_at, now)}</p>
  </div>
</li>`;
}

function filterParams(filters) {
  const params = {};
  if (filters.q) params.q = filters.q;
  if (filters.category) params.category = filters.category;
  if (filters.type) params.type = filters.type;
  return params;
}

function filterLink(site, filters, change, label, current) {
  return html`<li><a class="filter-link" href="${site.link("/", filterParams({ ...filters, ...change }))}"${current ? raw(' aria-current="true"') : ""}><span>${label}</span></a></li>`;
}

// "Back to the newest / Older jobs" links under the job list. The board reads
// PAGE_ROWS live jobs at a time; `nextCursor` points at the next batch.
function boardPager(site, filters, after, nextCursor) {
  if (!after && !nextCursor) return "";
  return html`<nav class="pager" aria-label="More jobs">
    ${after ? html`<a class="button button-small button-quiet" href="${site.link("/", filterParams(filters))}">Back to the newest</a>` : html`<span></span>`}
    ${nextCursor ? html`<a class="button button-small button-quiet" href="${site.link("/", { ...filterParams(filters), after: nextCursor })}" rel="next">Older jobs</a>` : html`<span></span>`}
  </nav>`;
}

/**
 * The public board. `pageJobs` is one page of live jobs (up to PAGE_ROWS,
 * already narrowed by category and schedule); `jobs` is the ones that also
 * match the search words. `after` is set on older pages, and `nextCursor` when
 * there are older jobs still to show.
 */
export function boardPage(site, { jobs, pageJobs = jobs, filters, after = "", nextCursor = "", now = Date.now() }) {
  const activeParts = [
    filters.category ? categoryLabel(filters.category) : "",
    filters.type ? jobTypeLabel(filters.type) : "",
    filters.q ? `matching “${filters.q}”` : ""
  ].filter(Boolean);
  const anyFilter = activeParts.length > 0;
  // The total is only known when every live job fits on this one page.
  const unfiltered = !filters.category && !filters.type && !after;
  const employers = new Set(pageJobs.map((job) => job.employer)).size;
  const eyebrow = !unfiltered
    ? "Farm and food jobs"
    : nextCursor
      ? `${pageJobs.length}+ open jobs`
      : `${pageJobs.length} open ${pageJobs.length === 1 ? "job" : "jobs"} from ${employers} ${employers === 1 ? "employer" : "employers"}`;
  const partial = Boolean(after || nextCursor);
  const heading = `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}${partial ? " on this page" : ""}`;
  const nothingAtAll = pageJobs.length === 0 && !anyFilter && !after;

  const body = html`<section class="hero" aria-labelledby="hero-title">
  <div class="wrap hero-inner">
    <div class="hero-copy">
      <p class="eyebrow">${eyebrow}</p>
      <h1 id="hero-title">Work that grows things.</h1>
      <p class="lede">Jobs on small farms, orchards, ranches, and food projects across the Pacific Northwest. A real person reads every listing before it goes up.</p>
    </div>
  </div>
  ${FIELDS_ART}
</section>
<div class="wrap board">
  <aside class="filters" aria-label="Filter jobs">
    <form class="search" method="get" action="/" role="search">
      <label for="q">Search jobs</label>
      <div class="search-row">
        <input id="q" name="q" type="search" value="${filters.q}" placeholder="Job, farm, or town" maxlength="80">
        ${filters.category ? html`<input type="hidden" name="category" value="${filters.category}">` : ""}
        ${filters.type ? html`<input type="hidden" name="type" value="${filters.type}">` : ""}
        ${site.hiddenFields()}
        <button class="button button-small" type="submit">Search</button>
      </div>
    </form>
    <nav class="filter-group" aria-labelledby="filter-category">
      <h2 id="filter-category">Kind of work</h2>
      <ul>
        ${filterLink(site, filters, { category: "" }, "All kinds", !filters.category)}
        ${CATEGORIES.map((category) => filterLink(site, filters, { category: category.id }, category.label, filters.category === category.id))}
      </ul>
    </nav>
    <nav class="filter-group" aria-labelledby="filter-type">
      <h2 id="filter-type">Schedule</h2>
      <ul>
        ${filterLink(site, filters, { type: "" }, "Any schedule", !filters.type)}
        ${JOB_TYPES.map((type) => filterLink(site, filters, { type: type.id }, type.label, filters.type === type.id))}
      </ul>
    </nav>
    <div class="hiring-card">
      <h2>Hiring?</h2>
      <p>Post a job for free. We check each listing and put it live within two business days.</p>
      <a class="button button-soil" href="${site.link("/post")}">Post a job</a>
    </div>
  </aside>
  <section class="results" aria-labelledby="results-title">
    <div class="results-head">
      <h2 id="results-title">${heading}${anyFilter ? html` <span class="results-filter">${activeParts.join(" · ")}</span>` : ""}</h2>
      ${anyFilter ? html`<a class="clear-link" href="${site.link("/")}">Clear filters</a>` : ""}
    </div>
    ${filters.q && nextCursor ? html`<p class="muted">Search looks through ${PAGE_ROWS} jobs at a time. Choose “Older jobs” below to search further back.</p>` : ""}
    ${
      jobs.length > 0
        ? html`<ol class="job-list">${jobs.map((job) => jobCard(site, job, now))}</ol>`
        : html`<div class="empty">
      <h3>${nothingAtAll ? "No jobs posted yet" : "Nothing matches those filters"}</h3>
      <p>${nothingAtAll ? "New listings show up here as soon as they're approved." : nextCursor ? "There are older jobs to look through below, or clear the filters to see every open job." : "Try a different kind of work or schedule, or clear the filters to see every open job."}</p>
      ${nothingAtAll ? html`<a class="button" href="${site.link("/post")}">Post the first job</a>` : html`<a class="button" href="${site.link("/")}">See all jobs</a>`}
    </div>`
    }
    ${boardPager(site, filters, after, nextCursor)}
  </section>
</div>`;

  // Browser tab title, e.g. "Jobs matching “pear” · Orchards & vineyards" or "Seasonal jobs".
  const filterLabels = [filters.category ? categoryLabel(filters.category) : "", filters.type ? jobTypeLabel(filters.type) : ""].filter(Boolean);
  const title = filters.q
    ? [`Jobs matching “${filters.q}”`, ...filterLabels].join(" · ")
    : filterLabels.length > 0
      ? `${filterLabels.join(" · ")} jobs`
      : "";
  return page(site, { title, body, nav: "board", description: "Jobs on small farms, orchards, ranches, and food projects across the Pacific Northwest, each one checked by a person before it goes up." });
}

const EMPLOYMENT_TYPES = { "full-time": "FULL_TIME", "part-time": "PART_TIME", seasonal: "TEMPORARY", apprenticeship: "INTERN" };

export function jobPage(site, { job, related, now = Date.now() }) {
  const href = applyHref(job.apply_link);
  const byEmail = href?.startsWith("mailto:");
  const body = html`<div class="wrap detail">
  <p class="crumb"><a href="${site.link("/")}"><span aria-hidden="true">←</span> All jobs</a></p>
  <div class="detail-grid">
    <article class="job-detail" aria-labelledby="job-title">
      <p class="job-tags"><span class="tag cat-${job.category}">${categoryLabel(job.category)}</span><span class="tag tag-plain">${jobTypeLabel(job.job_type)}</span>${job.featured ? html`<span class="tag tag-featured">Featured</span>` : ""}</p>
      <h1 id="job-title">${job.title}</h1>
      <p class="detail-employer"><span class="job-mark cat-${job.category}" aria-hidden="true">${initials(job.employer)}</span>${job.employer}</p>
      <dl class="facts">
        <div><dt>Location</dt><dd>${job.location}</dd></div>
        <div><dt>Schedule</dt><dd>${jobTypeLabel(job.job_type)}</dd></div>
        <div><dt>Pay</dt><dd>${job.pay || "Ask the employer"}</dd></div>
        <div><dt>Posted</dt><dd>${timeAgo(job.published_at, now)}</dd></div>
      </dl>
      <div class="prose">
        <p class="prose-lede">${job.summary}</p>
        ${paragraphs(job.description)}
      </div>
    </article>
    <aside class="apply-card" aria-labelledby="apply-title">
      <h2 id="apply-title">How to apply</h2>
      <p>Apply directly with ${job.employer}. ${byEmail ? "Send a short note about yourself and when you could start." : "Their application page opens in a new tab."}</p>
      ${href ? html`<a class="button button-wide" href="${href}"${byEmail ? "" : raw(' target="_blank" rel="noopener noreferrer nofollow"')}>${byEmail ? `Email ${job.employer}` : "Apply on their site"}</a>` : ""}
      <p class="fine">${byEmail ? job.apply_link : ""}</p>
      <p class="fine">Let them know you found the job on ${BRAND.name}.</p>
    </aside>
  </div>
  ${
    related.length > 0
      ? html`<section class="related" aria-labelledby="related-title">
    <h2 id="related-title">More ${categoryLabel(job.category).toLowerCase()} jobs</h2>
    <ol class="job-list">${related.map((item) => jobCard(site, item, now))}</ol>
  </section>`
      : ""
  }
</div>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: `${job.summary}\n\n${job.description}`,
    datePosted: job.published_at,
    employmentType: EMPLOYMENT_TYPES[job.job_type],
    hiringOrganization: { "@type": "Organization", name: job.employer },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: job.location } }
  };
  return page(site, { title: `${job.title} at ${job.employer}`, description: job.summary, body, jsonLd });
}

// ---------------------------------------------------------------------------
// Listing form (shared by the public "Post a job" page and the owner editor)
// ---------------------------------------------------------------------------

function field(name, label, { values, errors, hint = "", type = "text", autocomplete = "", textarea = false, rows = 8, placeholder = "" }) {
  const limit = FIELD_LIMITS[name];
  const describedBy = [hint ? `${name}-hint` : "", errors[name] ? `${name}-error` : ""].filter(Boolean).join(" ");
  const common = html`id="${name}" name="${name}"${limit?.min > 0 ? raw(" required") : ""}${limit ? html` maxlength="${limit.max}"` : ""}${describedBy ? html` aria-describedby="${describedBy}"` : ""}${errors[name] ? raw(' aria-invalid="true"') : ""}${placeholder ? html` placeholder="${placeholder}"` : ""}`;
  return html`<div class="field${errors[name] ? " has-error" : ""}">
  <label for="${name}">${label}${limit?.min === 0 ? html` <span class="optional">optional</span>` : ""}</label>
  ${hint ? html`<p class="hint" id="${name}-hint">${hint}</p>` : ""}
  ${errors[name] ? html`<p class="error" id="${name}-error">${errors[name]}</p>` : ""}
  ${textarea ? html`<textarea ${common} rows="${rows}">${values[name] ?? ""}</textarea>` : html`<input ${common} type="${type}" value="${values[name] ?? ""}"${autocomplete ? html` autocomplete="${autocomplete}"` : ""}>`}
</div>`;
}

function selectField(name, label, options, { values, errors }) {
  return html`<div class="field${errors[name] ? " has-error" : ""}">
  <label for="${name}">${label}</label>
  ${errors[name] ? html`<p class="error" id="${name}-error">${errors[name]}</p>` : ""}
  <select id="${name}" name="${name}" required${errors[name] ? html` aria-invalid="true" aria-describedby="${name}-error"` : ""}>
    <option value="">Choose one</option>
    ${options.map((option) => html`<option value="${option.id}"${values[name] === option.id ? raw(" selected") : ""}>${option.label}</option>`)}
  </select>
</div>`;
}

const FIELD_LABELS = {
  title: "Job title",
  employer: "Farm or organization",
  location: "Location",
  category: "Kind of work",
  job_type: "Schedule",
  pay: "Pay",
  summary: "One-line summary",
  description: "About the job",
  apply_link: "How to apply",
  contact_name: "Your name",
  contact_email: "Your email",
  owner_note: "Private note"
};

// Errors are listed in the order the fields appear on the form.
const FORM_ORDER = ["title", "category", "job_type", "location", "pay", "summary", "description", "employer", "apply_link", "contact_name", "contact_email", "owner_note"];

function errorSummary(errors) {
  const entries = FORM_ORDER.filter((name) => errors[name]).map((name) => [name, errors[name]]);
  if (entries.length === 0) return "";
  return html`<div class="error-summary" role="alert" aria-labelledby="error-summary-title">
  <h2 id="error-summary-title">Please check ${entries.length === 1 ? "one thing" : `${entries.length} things`}</h2>
  <ul>${entries.map(([name, message]) => html`<li><a href="#${name}">${FIELD_LABELS[name] ?? name}: ${message}</a></li>`)}</ul>
</div>`;
}

function listingFields(state) {
  return html`<fieldset>
  <legend>The job</legend>
  ${field("title", FIELD_LABELS.title, { ...state, placeholder: "Orchard crew lead" })}
  <div class="field-row">
    ${selectField("category", FIELD_LABELS.category, CATEGORIES, state)}
    ${selectField("job_type", FIELD_LABELS.job_type, JOB_TYPES, state)}
  </div>
  <div class="field-row">
    ${field("location", FIELD_LABELS.location, { ...state, hint: "Town and state, like Hood River, OR." })}
    ${field("pay", FIELD_LABELS.pay, { ...state, hint: "Listings with pay get more replies." , placeholder: "$20–22/hr + housing" })}
  </div>
  ${field("summary", FIELD_LABELS.summary, { ...state, hint: "Shown on the job list. Up to 160 characters." })}
  ${field("description", FIELD_LABELS.description, { ...state, textarea: true, hint: "Daily work, season dates, housing, and what someone will learn. Plain text; leave a blank line between paragraphs." })}
</fieldset>
<fieldset>
  <legend>Your farm</legend>
  ${field("employer", FIELD_LABELS.employer, { ...state, autocomplete: "organization" })}
  ${field("apply_link", FIELD_LABELS.apply_link, { ...state, hint: "An email address or a link to your application page. Shown on the listing." })}
</fieldset>`;
}

export function postPage(site, { values = {}, errors = {}, status = 200 }) {
  const state = { values, errors };
  const body = html`<div class="wrap form-page">
  <div class="form-intro">
    <h1>Post a job</h1>
    <p class="lede">Posting is free for farms, ranches, and food projects in the Pacific Northwest.</p>
    <ol class="steps">
      <li><strong>Tell us about the job.</strong> The more detail, the better the applicants.</li>
      <li><strong>We read every listing.</strong> Most go live within two business days.</li>
      <li><strong>People apply to you directly.</strong> By email or on your own site.</li>
    </ol>
  </div>
  <form class="listing-form" method="post" action="${site.link("/post")}" novalidate>
    ${errorSummary(errors)}
    ${listingFields(state)}
    <fieldset>
      <legend>Who we can contact</legend>
      <p class="fieldset-note">Only the ${BRAND.name} team sees this. It's never shown on the listing.</p>
      <div class="field-row">
        ${field("contact_name", FIELD_LABELS.contact_name, { ...state, autocomplete: "name" })}
        ${field("contact_email", FIELD_LABELS.contact_email, { ...state, type: "email", autocomplete: "email" })}
      </div>
    </fieldset>
    <div class="trap" aria-hidden="true">
      <label for="website">Leave this empty</label>
      <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
    </div>
    <div class="form-actions">
      <button class="button" type="submit">Send for review</button>
      <p class="fine">By posting, you confirm the job is real and pays at least the local minimum wage.</p>
    </div>
  </form>
</div>`;
  return page(site, { title: "Post a job", body, status, nav: "post", description: "Post a farm or food job on Loamwork. Free for employers in the Pacific Northwest." });
}

export function thanksPage(site, { demoNext = null }) {
  const body = html`<div class="wrap narrow">
  <div class="confirm">
    <p class="confirm-icon" aria-hidden="true">${LOGO}</p>
    <h1>Thanks! Your listing is in the review queue.</h1>
    <p class="lede">We read every listing before it goes live, usually within two business days. If we have a question, we'll get in touch at the email you gave us.</p>
    ${demoNext ?? ""}
    <p><a href="${site.link("/")}">Back to all jobs</a></p>
  </div>
</div>`;
  return page(site, { title: "Listing received", body, nav: "post" });
}

export function messagePage(site, { title, message, status, action = "" }) {
  const body = html`<div class="wrap narrow">
  <div class="confirm">
    <h1>${title}</h1>
    <p class="lede">${message}</p>
    ${action}
    <p><a href="${site.link("/")}">Back to all jobs</a></p>
  </div>
</div>`;
  return page(site, { title, body, status });
}

// ---------------------------------------------------------------------------
// Owner pages
// ---------------------------------------------------------------------------

export const OWNER_TABS = [
  { id: "pending", label: "To review" },
  { id: "approved", label: "Live" },
  { id: "rejected", label: "Declined" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" }
];

const DONE_MESSAGES = {
  approved: (title) => `“${title}” is live on the board.`,
  rejected: (title) => `“${title}” was declined. It won't appear on the board.`,
  closed: (title) => `“${title}” is closed and off the board.`,
  pending: (title) => `“${title}” is back in the review queue.`,
  saved: (title) => `Changes to “${title}” are saved.`
};

// The message shown after an owner action, or "" when there isn't one.
function flashMessage({ done, doneJob, doneCount, doneMore }) {
  if (done === "deleted") return "The listing is deleted.";
  if (done === "cleared") {
    const deleted = doneCount === 1 ? "Deleted 1 declined listing." : `Deleted ${doneCount} declined listings.`;
    return doneMore ? `${deleted} There are more; delete again to clear the rest.` : deleted;
  }
  return doneJob && Object.hasOwn(DONE_MESSAGES, done) ? DONE_MESSAGES[done](doneJob.title) : "";
}

// A count for a tab: "100+" when there are more than one data call reads.
function countLabel({ count, more }) {
  return more ? `${count}+` : String(count);
}

// A contact email as a mailto link, or plain text if it isn't a clean address.
function contactEmail(email) {
  return isEmail(email) ? html`<a href="mailto:${email}">${email}</a>` : email;
}

function activityText(entry, job) {
  switch (entry.action) {
    case "submitted":
      return html`New listing from ${job.employer}: <strong>${job.title}</strong>`;
    case "approved":
      return html`Approved <strong>${job.title}</strong>`;
    case "rejected":
      return html`Declined <strong>${job.title}</strong>`;
    case "closed":
      return html`Closed <strong>${job.title}</strong>`;
    case "pending":
      return html`Moved <strong>${job.title}</strong> back to review`;
    case "edited":
      return html`Edited <strong>${job.title}</strong>`;
    default:
      return html`Updated <strong>${job.title}</strong>`;
  }
}

function statusButtons(site, job, tab) {
  const form = (status, label, style) => html`<form method="post" action="${site.link(`/owner/jobs/${job.id}/status`, { tab })}">
      <input type="hidden" name="status" value="${status}">
      <button class="button button-small ${style}" type="submit">${label}<span class="visually-hidden"> “${job.title}”</span></button>
    </form>`;
  const buttons = [];
  if (job.status !== "approved") buttons.push(form("approved", job.status === "pending" ? "Approve" : "Put live", "button-moss"));
  if (job.status === "pending") buttons.push(form("rejected", "Decline", "button-quiet"));
  if (job.status === "approved") buttons.push(form("closed", "Mark as filled", "button-quiet"));
  return buttons;
}

/**
 * The owner's listings page. `jobs` is one page of the chosen tab; `pending` is
 * the review queue's { count, more }; `recent` is the listings already read for
 * this page, used for the activity panel; `nextCursor` links to the next page.
 *
 * Counting every status would mean reading every listing, so only "To review"
 * always shows a count. The open tab shows one too when its first page holds
 * all of it (or "100+" when it doesn't).
 */
export function ownerPage(site, { jobs, pending, recent, tab, after = "", nextCursor = "", done = "", doneJob = null, doneCount = 0, doneMore = false, user, now = Date.now(), notice = "" }) {
  const tabCounts = { pending: countLabel(pending) };
  if (!after && tab !== "pending") tabCounts[tab] = countLabel({ count: jobs.length, more: Boolean(nextCursor) });
  const shown = jobs;
  const flash = flashMessage({ done, doneJob, doneCount, doneMore });
  const activity = recent
    .flatMap((job) => job.history.map((entry) => ({ entry, job })))
    .sort((left, right) => right.entry.at.localeCompare(left.entry.at))
    .slice(0, 7);

  const body = html`<div class="wrap owner">
  ${notice}
  <div class="owner-head">
    <div>
      <p class="eyebrow">Owner</p>
      <h1>Listings</h1>
    </div>
    ${user ? html`<p class="owner-user">Signed in as ${user.email} <span aria-hidden="true">·</span> <a href="/_userland/auth/logout?return_to=/">Sign out</a></p>` : ""}
  </div>
  ${flash ? html`<p class="flash" role="status">${flash}${done === "approved" && doneJob ? html` <a href="${site.link(`/jobs/${doneJob.id}`)}">View listing</a>` : ""}</p>` : ""}
  <nav class="tabs" aria-label="Listings by status">
    ${OWNER_TABS.map((item) => html`<a href="${site.link("/owner", { tab: item.id })}"${tab === item.id ? raw(' aria-current="page"') : ""}>${item.label}${Object.hasOwn(tabCounts, item.id) ? html` <span class="count">${tabCounts[item.id]}</span>` : ""}</a>`)}
  </nav>
  <div class="owner-grid">
    <section aria-label="${OWNER_TABS.find((item) => item.id === tab)?.label ?? "Listings"}">
      ${
        shown.length > 0
          ? html`<ol class="queue">${shown.map(
              (job) => html`<li class="queue-item">
        <div class="queue-body">
          <p class="status status-${job.status}">${STATUS_LABELS[job.status]}${job.featured ? html` <span class="tag tag-featured">Featured</span>` : ""}</p>
          <h2 class="queue-title"><a href="${site.link(`/owner/jobs/${job.id}`)}">${job.title}</a></h2>
          <p class="queue-meta">${job.employer} <span aria-hidden="true">·</span> ${job.location} <span aria-hidden="true">·</span> ${categoryLabel(job.category)} <span aria-hidden="true">·</span> sent ${timeAgo(job.submitted_at, now)}</p>
          <p class="queue-summary">${job.summary}</p>
          <p class="queue-contact">Contact: ${job.contact_name}, ${contactEmail(job.contact_email)}</p>
          ${job.owner_note ? html`<p class="queue-note"><span>Note:</span> ${job.owner_note}</p>` : ""}
        </div>
        <div class="queue-actions">
          ${statusButtons(site, job, tab)}
          <a class="button button-small button-quiet" href="${site.link(`/owner/jobs/${job.id}`)}">Edit<span class="visually-hidden"> “${job.title}”</span></a>
        </div>
      </li>`
            )}</ol>
      ${
        after || nextCursor
          ? html`<nav class="pager" aria-label="More listings">
        ${after ? html`<a class="button button-small button-quiet" href="${site.link("/owner", { tab })}">Back to the newest</a>` : html`<span></span>`}
        ${nextCursor ? html`<a class="button button-small button-quiet" href="${site.link("/owner", { tab, after: nextCursor })}" rel="next">Show more</a>` : html`<span></span>`}
      </nav>`
          : ""
      }`
          : html`<div class="empty"><h3>Nothing here right now</h3><p>${tab === "pending" ? "New listings land here for you to review." : "Listings with this status will show up here."}</p></div>`
      }
      ${
        tab === "rejected" && jobs.length > 0
          ? html`<div class="owner-tools"><a class="button button-small button-quiet" href="${site.link("/owner/declined/delete")}">Delete declined listings</a><p class="fine">Clears out spam and listings you turned down. Deleted listings can't be brought back.</p></div>`
          : ""
      }
    </section>
    <aside class="owner-side">
      <section class="panel" aria-labelledby="activity-title">
        <h2 id="activity-title">Recent activity</h2>
        ${
          activity.length > 0
            ? html`<ol class="activity">${activity.map(({ entry, job }) => html`<li><span>${activityText(entry, job)}</span><time datetime="${entry.at}">${timeAgo(entry.at, now)}</time></li>`)}</ol>`
            : html`<p class="muted">Nothing yet.</p>`
        }
      </section>
      <section class="panel" aria-labelledby="insight-title">
        <h2 id="insight-title">Activity and errors</h2>
        <p>Every new listing and review decision is written to the app's activity log in your Userland console, along with any errors. On Starter and up, the console also shows how many people visit the board, which jobs they open, and where they came from.</p>
      </section>
    </aside>
  </div>
</div>`;
  return page(site, { title: "Owner: listings", body, nav: "owner", description: "Review, approve, and edit job listings." });
}

export function ownerEditPage(site, { job, values, errors = {}, status = 200, notice = "" }) {
  const state = { values, errors };
  const body = html`<div class="wrap form-page owner-edit">
  ${notice}
  <div class="form-intro">
    <p class="crumb"><a href="${site.link("/owner")}"><span aria-hidden="true">←</span> All listings</a></p>
    <h1>Edit listing</h1>
    <p class="status status-${job.status}">${STATUS_LABELS[job.status]}</p>
    <p class="muted">Sent ${timeAgo(job.submitted_at)} by ${job.contact_name} (${contactEmail(job.contact_email)}).</p>
    ${job.status === "approved" ? html`<p><a href="${site.link(`/jobs/${job.id}`)}">See it on the board</a></p>` : ""}
    <div class="owner-tools">
      <a class="button button-small button-quiet" href="${site.link(`/owner/jobs/${job.id}/delete`)}">Delete this listing</a>
      <p class="fine">For spam or listings you don't need to keep. To take a live job off the board but keep it, use “Mark as filled” instead.</p>
    </div>
  </div>
  <form class="listing-form" method="post" action="${site.link(`/owner/jobs/${job.id}`)}" novalidate>
    ${errorSummary(errors)}
    ${listingFields(state)}
    <fieldset>
      <legend>Contact and notes</legend>
      <div class="field-row">
        ${field("contact_name", FIELD_LABELS.contact_name.replace("Your", "Contact"), state)}
        ${field("contact_email", FIELD_LABELS.contact_email.replace("Your", "Contact"), { ...state, type: "email" })}
      </div>
      ${field("owner_note", FIELD_LABELS.owner_note, { ...state, textarea: true, rows: 3, hint: "Only you see this." })}
      <div class="check">
        <input id="featured" name="featured" type="checkbox"${values.featured ? raw(" checked") : ""}>
        <label for="featured">Feature this job at the top of the board</label>
      </div>
    </fieldset>
    <div class="form-actions">
      <button class="button" type="submit">Save changes</button>
      <a class="button button-quiet" href="${site.link("/owner")}">Cancel</a>
    </div>
  </form>
</div>`;
  return page(site, { title: `Edit: ${job.title}`, body, status, nav: "owner" });
}

/**
 * "Are you sure?" page before deleting. Pass `job` to delete one listing, or
 * `declined` ({ count, more } for the Declined tab) to delete declined listings.
 */
export function confirmDeletePage(site, { job = null, declined = null, notice = "" }) {
  const action = job ? site.link(`/owner/jobs/${job.id}/delete`) : site.link("/owner/declined/delete");
  const back = job ? site.link(`/owner/jobs/${job.id}`) : site.link("/owner", { tab: "rejected" });
  const count = declined?.count ?? 0;
  const heading = job ? html`Delete “${job.title}”?` : "Delete declined listings?";
  const detail = job
    ? html`This removes the listing from ${job.employer} and its contact details for good. It can't be brought back.`
    : count === 0
      ? "There are no declined listings to delete."
      : html`This deletes ${count > BULK_DELETE_MAX ? `the first ${BULK_DELETE_MAX} of ${countLabel(declined)}` : countLabel(declined)} declined ${count === 1 ? "listing" : "listings"} for good. They can't be brought back.`;
  const body = html`<div class="wrap narrow">
  ${notice}
  <div class="confirm">
    <h1>${heading}</h1>
    <p class="lede">${detail}</p>
    ${
      job || count > 0
        ? html`<form method="post" action="${action}" class="confirm-actions">
      <button class="button button-danger" type="submit">${job ? "Delete listing" : "Delete declined listings"}</button>
      <a class="button button-quiet" href="${back}">Cancel</a>
    </form>`
        : html`<p><a class="button button-quiet" href="${back}">Back to listings</a></p>`
    }
  </div>
</div>`;
  return page(site, { title: job ? `Delete: ${job.title}` : "Delete declined listings", body, nav: "owner" });
}

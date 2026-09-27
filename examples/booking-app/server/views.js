// Server-rendered HTML for every page. No client-side JavaScript is needed.
// Every value that comes from a visitor or from stored data goes through esc().

import { STUDIO_HOURS, describeInstant, formatClock, formatDayName, formatDayNumber, formatMonthShort, formatDateLong, timeAgo } from "./schedule.js";

export const STUDIO = {
  name: "Wrenhouse",
  fullName: "Wrenhouse Music Studio",
  teacher: "Nora",
  email: "hello@example.com",
  place: "Upstairs at 212 Alder Street",
  tagline: "Piano & voice lessons"
};

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatPrice(cents) {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!domain) return "your email";
  return `${name.slice(0, 1)}•••@${domain}`;
}

const STATUS_LABELS = {
  new: "New",
  confirmed: "Confirmed",
  declined: "Declined",
  cancelled: "Cancelled"
};

const ACTION_LABELS = {
  confirmed: "Confirm",
  declined: "Decline",
  cancelled: "Mark cancelled",
  new: "Move back to new"
};

const HISTORY_LABELS = {
  new: "Request received",
  confirmed: "Confirmed",
  declined: "Declined",
  cancelled: "Cancelled"
};

// The studio mark: a little wren house whose doorway is a fermata, the
// musical sign for "hold this note".
export function logoMark(className = "mark") {
  return `<svg class="${className}" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><path d="M20 3.5 36 15.2V36.5H4V15.2Z" fill="#1E4A37" stroke="#1E4A37" stroke-width="2" stroke-linejoin="round"/><path d="M12.4 26.5a7.6 7.6 0 0 1 15.2 0" fill="none" stroke="#C99B4E" stroke-width="2.4" stroke-linecap="round"/><circle cx="20" cy="25.2" r="2.5" fill="#C99B4E"/></svg>`;
}

function fermata(className = "ornament") {
  return `<svg class="${className}" viewBox="0 0 64 28" aria-hidden="true" focusable="false"><path d="M6 25a26 22 0 0 1 52 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="32" cy="21" r="3.6" fill="currentColor"/></svg>`;
}

/**
 * The page shell. `chrome` carries the demo settings:
 * { demo: boolean, link(path): string, examplePageUrl: string }.
 */
export function layout({ title, description = "", body, chrome, area = "public", current = "", user = null, noindex = false }) {
  const robots = noindex || chrome.demo || area === "studio" ? `\n    <meta name="robots" content="noindex,follow">` : "";
  const pageTitle = title ? `${title} · ${STUDIO.fullName}` : `${STUDIO.fullName} · ${STUDIO.tagline}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(pageTitle)}</title>${description ? `\n    <meta name="description" content="${esc(description)}">` : ""}${robots}
    <meta name="referrer" content="same-origin">
    <meta name="theme-color" content="#1E4A37">
    <link rel="preload" href="/assets/fonts/newsreader-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/fonts/instrument-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/assets/styles.css">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  </head>
  <body class="area-${area}">
    <a class="skip" href="#main">Skip to content</a>
    ${chrome.demo ? demoRibbon(area, chrome) : ""}
    ${area === "studio" ? studioHeader(chrome, current, user) : publicHeader(chrome, current)}
    <main id="main" tabindex="-1">
${body}
    </main>
    ${area === "studio" ? studioFooter(chrome) : publicFooter(chrome)}
  </body>
</html>`;
}

function demoRibbon(area, chrome) {
  if (area === "studio") {
    return `<div class="ribbon" role="note"><div class="wrap ribbon-inner"><p><strong>You're viewing the owner's side, with no sign-in for this demo.</strong> Sample bookings are made up. Your changes are cleared after a day. Anyone with this page's link can see them, so use made-up details.</p></div></div>`;
  }
  return `<div class="ribbon" role="note"><div class="wrap ribbon-inner"><p><strong>This is a demo booking site</strong> for a made-up music studio. Request a lesson, then see what the owner sees. Use made-up details: anyone with this page's link can see what you type.</p><a href="${esc(chrome.link("/studio"))}">Open the owner's side</a></div></div>`;
}

function publicHeader(chrome, current) {
  const link = chrome.link;
  return `<header class="site-header">
      <div class="wrap header-inner">
        <a class="brand" href="${esc(link("/"))}">${logoMark()}<span class="brand-text"><span class="brand-name">${STUDIO.name}</span><span class="brand-sub">Music Studio</span></span></a>
        <nav class="site-nav" aria-label="Main">
          <a href="${esc(link("/#lessons"))}" class="hide-sm">Lessons</a>
          <a href="${esc(link("/#studio"))}" class="hide-sm">The studio</a>
          <a class="button button-small" href="${esc(link("/book"))}"${current === "book" ? ' aria-current="page"' : ""}>Book a lesson</a>
        </nav>
      </div>
    </header>`;
}

function studioHeader(chrome, current, user) {
  const link = chrome.link;
  const item = (key, href, label) => `<a href="${esc(link(href))}"${current === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const account = user
    ? `<a class="studio-signout" href="/_userland/auth/logout?return_to=/">Sign out</a>`
    : `<a class="studio-signout" href="${esc(link("/"))}">View booking page</a>`;
  return `<header class="site-header studio-header">
      <div class="wrap header-inner">
        <a class="brand" href="${esc(link("/studio"))}">${logoMark()}<span class="brand-text"><span class="brand-name">${STUDIO.name}</span><span class="brand-sub">Studio desk</span></span></a>
        ${account}
      </div>
      <div class="wrap">
        <nav class="studio-nav" aria-label="Studio">
          ${item("requests", "/studio", "Requests")}
          ${item("lessons", "/studio/lessons", "Lessons")}
          ${item("activity", "/studio/activity", "Activity")}
        </nav>
      </div>
    </header>`;
}

function builtWith(chrome) {
  if (!chrome.demo) return "";
  return `<p class="built-with">Demo app. Built with Userland. <a href="${esc(chrome.examplePageUrl)}">See how it's made</a></p>`;
}

function publicFooter(chrome) {
  return `<footer class="site-footer">
      <div class="wrap footer-inner">
        <div class="footer-brand">${logoMark("mark mark-small")}<div><p class="footer-name">${STUDIO.fullName}</p><p>${STUDIO.place} · <a href="mailto:${STUDIO.email}">${STUDIO.email}</a></p></div></div>
        <p class="footer-links"><a href="${esc(chrome.link("/studio"))}">${chrome.demo ? "Owner's side" : "Studio sign-in"}</a></p>
      </div>
      <div class="wrap">${builtWith(chrome)}</div>
    </footer>`;
}

function studioFooter(chrome) {
  return `<footer class="site-footer studio-footer"><div class="wrap">${builtWith(chrome) || `<p class="built-with">${STUDIO.fullName}</p>`}</div></footer>`;
}

// ---------------------------------------------------------------------------
// Public pages

export function homePage({ services, chrome }) {
  const link = chrome.link;
  const rows = services
    .map(
      (service) => `<li>
            <a class="program-row" href="${esc(link(`/book?service=${encodeURIComponent(service.id)}`))}">
              <span class="program-name">${esc(service.name)}</span>
              <span class="program-leader" aria-hidden="true"></span>
              <span class="program-meta">${service.duration_minutes} min · ${formatPrice(service.price_cents)}</span>
              <span class="program-summary">${esc(service.summary)}</span>
            </a>
          </li>`
    )
    .join("\n          ");
  const hours = Object.entries(STUDIO_HOURS.weekly)
    .map(([day, [open, close]]) => `<li><span>${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][day]}</span><span>${formatClock(open)} – ${formatClock(close)}</span></li>`)
    .join("");
  return `      <section class="hero">
        <div class="wrap hero-grid">
          <div class="hero-copy">
            <p class="eyebrow">${STUDIO.tagline} · Alder Street</p>
            <h1>Piano and voice lessons at an <em>unhurried</em> pace.</h1>
            <p class="lead">One-to-one lessons for children and adults, in a sunny upstairs studio or online. Choose a lesson, pick a time that suits you, and ${STUDIO.teacher} will confirm within a day.</p>
            <div class="actions">
              <a class="button" href="${esc(link("/book"))}">Book a lesson</a>
              <a class="text-link" href="${esc(link("/#lessons"))}">Lessons and prices</a>
            </div>
          </div>
          <div class="program" id="lessons">
            <div class="program-head">${fermata()}<h2>This term's lessons</h2><p>All lessons are one-to-one</p></div>
            <ul class="program-list">
          ${rows || `<li class="empty">New lesson times are coming soon.</li>`}
            </ul>
            <p class="program-foot">First time here? Start with a <strong>first lesson</strong>. No payment until you arrive.</p>
          </div>
        </div>
      </section>

      <section class="band">
        <div class="wrap">
          <h2 class="section-title">How booking works</h2>
          <ol class="steps">
            <li><span class="numeral" aria-hidden="true">I</span><h3>Choose a lesson</h3><p>Piano, voice, or a relaxed first lesson to see if we're a good fit.</p></li>
            <li><span class="numeral" aria-hidden="true">II</span><h3>Pick a time</h3><p>Open times are shown for the next two weeks, in ${STUDIO_HOURS.timeZoneLabel}.</p></li>
            <li><span class="numeral" aria-hidden="true">III</span><h3>${STUDIO.teacher} confirms</h3><p>You'll hear back by email within one working day, usually sooner.</p></li>
          </ol>
        </div>
      </section>

      <section class="about" id="studio">
        <div class="wrap about-grid">
          <div>
            <h2 class="section-title">About the studio</h2>
            <p>${STUDIO.teacher} has taught piano and singing for fifteen years, from first notes to conservatory auditions. Lessons are patient and practical: good technique, music you actually want to play, and a plan you can keep up at home.</p>
            <blockquote><p>“Every lesson ends with one thing to practice and one thing to enjoy.”</p></blockquote>
          </div>
          <div class="visit">
            <h3>Visit</h3>
            <p>${STUDIO.place}.<br>Step-free entrance, piano and keyboard both available.</p>
            <h3>Lesson hours</h3>
            <ul class="hours">${hours}</ul>
            <p class="small">Need to reschedule? Just reply to your confirmation at least a day ahead.</p>
          </div>
        </div>
      </section>`;
}

/**
 * The booking form. `form` holds submitted values; `errors` maps field names to messages.
 */
export function bookPage({ services, selected, days, selectedDate, slots, form = {}, errors = {}, chrome }) {
  const link = chrome.link;
  const serviceCards = services
    .map((service) => {
      const isSelected = selected && service.id === selected.id;
      return `<li><a class="choice${isSelected ? " is-selected" : ""}" href="${esc(link(`/book?service=${encodeURIComponent(service.id)}#day`))}"${isSelected ? ' aria-current="true"' : ""}>
              <span class="choice-name">${esc(service.name)}</span>
              <span class="choice-meta">${service.duration_minutes} min · ${formatPrice(service.price_cents)}</span>
            </a></li>`;
    })
    .join("\n            ");
  const dayChips = days
    .map((day) => {
      const isSelected = day.date === selectedDate;
      const label = `${formatDateLong(day.date)}${day.open ? "" : ", fully booked"}`;
      const inner = `<span class="day-name">${formatDayName(day.date)}</span><span class="day-num">${formatDayNumber(day.date)}</span><span class="day-month">${formatMonthShort(day.date)}</span>`;
      if (!day.open) return `<li><span class="day is-full" aria-label="${esc(label)}">${inner}</span></li>`;
      return `<li><a class="day${isSelected ? " is-selected" : ""}" href="${esc(link(`/book?service=${encodeURIComponent(selected.id)}&date=${day.date}#time`))}" aria-label="${esc(label)}"${isSelected ? ' aria-current="true"' : ""}>${inner}</a></li>`;
    })
    .join("");
  const openSlots = slots.filter((slot) => slot.available);
  const timeChoices = openSlots.length
    ? openSlots
        .map(
          (slot) => `<label class="time"><input type="radio" name="time" value="${slot.time}" required${form.time === slot.time ? " checked" : ""}><span>${formatClock(slot.time)}</span></label>`
        )
        .join("")
    : `<p class="empty">No open times left on this day. Please pick another day.</p>`;
  const errorList = Object.entries(errors);
  const summary = errorList.length
    ? `<div class="error-summary" role="alert" tabindex="-1" id="problems"><h2>Please check your request</h2><ul>${errorList
        .map(([field, message]) => `<li><a href="#field-${esc(field)}">${esc(message)}</a></li>`)
        .join("")}</ul></div>`
    : "";

  return `      <div class="wrap page-head">
        <p class="eyebrow">Book a lesson</p>
        <h1>Request a lesson time</h1>
        <p class="lead">Pick a lesson and a time. ${STUDIO.teacher} confirms every request personally, usually within a day.</p>
      </div>
      <div class="wrap book-grid">
        <div class="book-main">
          ${summary}
          <section class="step" aria-labelledby="step-lesson">
            <h2 id="step-lesson"><span class="step-num">1</span> Lesson</h2>
            <ul class="choices" id="field-service_id">
            ${serviceCards}
            </ul>
          </section>
          <section class="step" id="day" aria-labelledby="step-day">
            <h2 id="step-day"><span class="step-num">2</span> Day</h2>
            <ul class="days">${dayChips}</ul>
          </section>
          <form class="step-form" method="post" action="${esc(link("/book"))}" novalidate>
            <input type="hidden" name="service_id" value="${esc(selected?.id)}">
            <input type="hidden" name="date" value="${esc(selectedDate)}">
            <section class="step" id="time" aria-labelledby="step-time">
              <h2 id="step-time"><span class="step-num">3</span> Time <span class="step-note">${selectedDate ? esc(formatDateLong(selectedDate)) : ""}</span></h2>
              <fieldset id="field-time"${errors.time ? ' aria-describedby="error-time"' : ""}>
                <legend class="visually-hidden">Start time, ${STUDIO_HOURS.timeZoneLabel}</legend>
                ${errors.time ? `<p class="field-error" id="error-time">${esc(errors.time)}</p>` : ""}
                <div class="times">${timeChoices}</div>
                <p class="hint">Times are ${STUDIO_HOURS.timeZoneLabel}.</p>
              </fieldset>
            </section>
            <section class="step" aria-labelledby="step-details">
              <h2 id="step-details"><span class="step-num">4</span> Your details</h2>
              <div class="fields">
                ${field({ name: "customer_name", label: "Your name", value: form.customer_name, error: errors.customer_name, autocomplete: "name", maxlength: 80, required: true })}
                ${field({ name: "customer_email", label: "Email", type: "email", value: form.customer_email, error: errors.customer_email, autocomplete: "email", maxlength: 254, required: true, hint: `${STUDIO.teacher} will confirm by email.` })}
                ${field({ name: "customer_phone", label: "Phone (optional)", type: "tel", value: form.customer_phone, error: errors.customer_phone, autocomplete: "tel", maxlength: 30 })}
                ${field({ name: "student_details", label: "Who is the lesson for?", value: form.student_details, error: errors.student_details, maxlength: 200, required: true, hint: "For example: “My son Leo, 9, one year of piano” or “Me, adult beginner”." })}
                ${field({ name: "message", label: "Anything else? (optional)", value: form.message, error: errors.message, maxlength: 1000, textarea: true })}
                <div class="trap" aria-hidden="true"><label for="field-company">Company</label><input id="field-company" name="company" type="text" tabindex="-1" autocomplete="off"></div>
              </div>
            </section>
            <div class="submit-row">
              <button class="button" type="submit"${openSlots.length ? "" : " disabled"}>Send request</button>
              <p class="hint">No payment now. You'll pay at your lesson.</p>
            </div>
          </form>
        </div>
        <aside class="book-aside" aria-label="Your request">
          <div class="summary-card">
            ${fermata()}
            <h2>Your request</h2>
            ${
              selected
                ? `<dl>
              <div><dt>Lesson</dt><dd>${esc(selected.name)}</dd></div>
              <div><dt>Length</dt><dd>${selected.duration_minutes} minutes</dd></div>
              <div><dt>Price</dt><dd>${formatPrice(selected.price_cents)}</dd></div>
              <div><dt>Day</dt><dd>${selectedDate ? esc(formatDateLong(selectedDate)) : "Pick a day"}</dd></div>
            </dl>
            <p class="small">${esc(selected.summary)}</p>`
                : `<p>Choose a lesson to begin.</p>`
            }
          </div>
        </aside>
      </div>`;
}

function field({ name, label, type = "text", value = "", error, autocomplete, maxlength, required = false, hint, textarea = false }) {
  const id = `field-${name}`;
  const described = [hint ? `hint-${name}` : "", error ? `error-${name}` : ""].filter(Boolean).join(" ");
  const attrs = `id="${id}" name="${name}"${autocomplete ? ` autocomplete="${autocomplete}"` : ""}${maxlength ? ` maxlength="${maxlength}"` : ""}${required ? " required" : ""}${error ? ' aria-invalid="true"' : ""}${described ? ` aria-describedby="${described}"` : ""}`;
  const control = textarea ? `<textarea ${attrs} rows="4">${esc(value)}</textarea>` : `<input ${attrs} type="${type}" value="${esc(value)}">`;
  return `<div class="field${error ? " has-error" : ""}">
                  <label for="${id}">${esc(label)}</label>
                  ${hint ? `<p class="hint" id="hint-${name}">${esc(hint)}</p>` : ""}
                  ${error ? `<p class="field-error" id="error-${name}">${esc(error)}</p>` : ""}
                  ${control}
                </div>`;
}

export function confirmationPage({ booking, chrome }) {
  const when = describeInstant(booking.starts_at);
  const firstName = String(booking.customer_name).split(/\s+/u)[0];
  return `      <div class="wrap narrow confirm">
        ${fermata("ornament ornament-large")}
        <p class="eyebrow">Request received</p>
        <h1>Thank you, ${esc(firstName)}. Your request is in.</h1>
        <p class="lead">${STUDIO.teacher} will confirm by email to ${esc(maskEmail(booking.customer_email))} within one working day.</p>
        <div class="ticket">
          <dl>
            <div><dt>Lesson</dt><dd>${esc(booking.service_name)}</dd></div>
            <div><dt>When</dt><dd>${esc(when.dateLong)}, ${esc(when.clock)}</dd></div>
            <div><dt>Length</dt><dd>${booking.duration_minutes} minutes</dd></div>
            <div><dt>Price</dt><dd>${formatPrice(booking.price_cents)}, paid at the lesson</dd></div>
            <div><dt>Reference</dt><dd class="ref">${esc(booking.ref)}</dd></div>
            <div><dt>Status</dt><dd><span class="pill pill-${esc(booking.status)}">${booking.status === "new" ? "Waiting for confirmation" : esc(STATUS_LABELS[booking.status])}</span></dd></div>
          </dl>
        </div>
        <h2 class="section-title small-title">What happens next</h2>
        <ul class="next">
          <li>${STUDIO.teacher} checks the time and replies to confirm, or suggests another time if it no longer works.</li>
          <li>The studio is ${STUDIO.place}. Online lessons get a video link by email. All times are ${STUDIO_HOURS.timeZoneLabel}.</li>
          <li>Need to change something? Reply to the confirmation email at least a day ahead.</li>
        </ul>
        <div class="actions">
          <a class="button" href="${esc(chrome.link("/"))}">Back to the studio</a>
          <a class="text-link" href="${esc(chrome.link("/book"))}">Request another lesson</a>
        </div>
        ${
          chrome.demo
            ? `<aside class="demo-next"><h2>Now see it from the owner's side</h2><p>Your request is waiting in the studio inbox, next to some made-up sample bookings. Only you can see it.</p><a class="button button-quiet" href="${esc(chrome.link(`/studio#booking-${booking.id}`))}">Open the studio inbox</a></aside>`
            : ""
        }
      </div>`;
}

export function thanksPage() {
  return `      <div class="wrap narrow confirm">
        ${fermata("ornament ornament-large")}
        <h1>Thank you. Your request has been sent.</h1>
        <p class="lead">${STUDIO.teacher} will be in touch within one working day.</p>
      </div>`;
}

export function messagePage({ title, text, chrome, linkHref = "/", linkLabel = "Back to the studio" }) {
  return `      <div class="wrap narrow confirm">
        ${fermata("ornament ornament-large")}
        <h1>${esc(title)}</h1>
        <p class="lead">${esc(text)}</p>
        <div class="actions"><a class="button" href="${esc(chrome.link(linkHref))}">${esc(linkLabel)}</a></div>
      </div>`;
}

// ---------------------------------------------------------------------------
// Studio (owner) pages

// Each tab is one status, read a page at a time, so no request is ever out of reach.
export const INBOX_TABS = [
  { key: "new", label: "New", empty: "You're all caught up. New requests will appear here." },
  { key: "upcoming", label: "Upcoming", empty: "No confirmed lessons coming up." },
  { key: "past", label: "Past lessons", empty: "No past lessons yet.", clearOut: "lessons" },
  { key: "declined", label: "Declined", empty: "No declined requests.", clearOut: "declined requests" },
  { key: "cancelled", label: "Cancelled", empty: "No cancelled lessons.", clearOut: "cancelled lessons" }
];

/** The inbox tab a booking is listed under. */
export function tabFor(booking, now) {
  if (booking.status === "confirmed") return Date.parse(booking.ends_at) > now.getTime() ? "upcoming" : "past";
  return booking.status;
}

function inboxNotice({ notice, updated, clearOut, tab }) {
  if (notice.kind === "taken") return `<p class="notice notice-warn" role="status">Someone else has that time now, so this request can't be confirmed or moved back to new.</p>`;
  if (notice.kind === "deleted") return `<p class="notice" role="status">Request deleted.</p>`;
  if (notice.kind === "cleared") {
    if (notice.count === 0) return `<p class="notice" role="status">Nothing to clear out. Nothing here is more than ${clearOut.olderThanDays} days old.</p>`;
    const more = notice.more ? ` There may be more. Select <strong>Clear out</strong> again to keep going.` : "";
    return `<p class="notice" role="status">Deleted ${notice.count} old ${esc(tab.clearOut ?? "requests")}.${more}</p>`;
  }
  if (updated) return `<p class="notice" role="status">${esc(updated.customer_name)}'s request is now <strong>${esc(STATUS_LABELS[updated.status].toLowerCase())}</strong>.</p>`;
  return "";
}

export function inboxPage({ bookings, tab, counts, paused, nextPage, firstPage, transitions, canDelete, updatedId, notice, clearOut, chrome, isSample, now }) {
  const link = chrome.link;
  const tabs = INBOX_TABS.map((item) => {
    const count = counts[item.key] === undefined ? "" : ` <span class="count">${counts[item.key]}</span>`;
    return `<li><a href="${esc(link(`/studio?show=${item.key}`))}"${item.key === tab.key ? ' aria-current="page"' : ""}>${item.label}${count}</a></li>`;
  }).join("");
  const updated = updatedId ? bookings.find((booking) => booking.id === updatedId) : null;
  const pausedNote = paused
    ? `<p class="notice notice-warn" role="status"><strong>New requests are paused.</strong> ${counts.new} requests are waiting for a reply. Confirm, decline, or delete some and the booking page opens again.</p>`
    : "";
  const cards = bookings.length
    ? bookings.map((booking) => bookingCard({ booking, tab, transitions, canDelete, chrome, isSample, now })).join("\n")
    : `<li class="empty-state">${fermata()}<p>${firstPage ? tab.empty : "No more requests here."}</p></li>`;
  const pager = [
    firstPage ? "" : `<a class="text-link" href="${esc(link(`/studio?show=${tab.key}`))}">Back to the start</a>`,
    nextPage ? `<a class="button button-quiet button-small" href="${esc(link(`/studio?show=${tab.key}&after=${encodeURIComponent(nextPage)}`))}">Show more</a>` : ""
  ].filter(Boolean);
  const tidy = tab.clearOut
    ? `<form class="tidy" method="post" action="${esc(link("/studio/bookings/clear-out"))}">
          <input type="hidden" name="show" value="${esc(tab.key)}">
          <p><strong>Make room.</strong> Your plan saves a limited number of requests. Clear out ${esc(tab.clearOut)} from more than ${clearOut.olderThanDays} days ago, ${clearOut.batch} at a time.</p>
          <button class="button button-quiet button-small" type="submit">Clear out</button>
        </form>`
    : "";
  const upcoming = counts.upcoming;
  return `      <div class="wrap studio-head">
        <div>
          <h1>Booking requests</h1>
          <p class="lead">${counts.new ? `<strong>${counts.new} new ${counts.new === 1 ? "request" : "requests"}</strong> waiting for a reply.` : "No requests waiting for a reply."} ${upcoming ? `${upcoming} confirmed ${upcoming === 1 ? "lesson" : "lessons"} coming up.` : ""}</p>
        </div>
      </div>
      <div class="wrap">
        ${pausedNote}${inboxNotice({ notice, updated, clearOut, tab })}
        <nav aria-label="Filter requests"><ul class="tabs">${tabs}</ul></nav>
        <ul class="bookings">
${cards}
        </ul>
        ${pager.length ? `<nav class="pager" aria-label="More requests">${pager.join("")}</nav>` : ""}
        ${tidy}
      </div>`;
}

function requestedAt(booking) {
  return (Array.isArray(booking.history) && booking.history[0]?.at) || booking.created_at;
}

/** A mailto: link for a stored address. Encoding keeps anything unusual in it from adding recipients or text. */
function mailto(email) {
  return `mailto:${encodeURIComponent(String(email ?? "")).replace("%40", "@")}`;
}

function bookingCard({ booking, tab, transitions, canDelete, chrome, isSample, now }) {
  const when = describeInstant(booking.starts_at);
  const action = (path, fields, label, primary = false) => `<form method="post" action="${esc(chrome.link(path))}">
                ${Object.entries(fields)
                  .map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`)
                  .join("")}
                <button class="button ${primary ? "" : "button-quiet"} button-small" type="submit">${label}<span class="visually-hidden"> ${esc(booking.customer_name)}</span></button>
              </form>`;
  const moves = (transitions[booking.status] ?? []).map((next) => action(`/studio/bookings/${encodeURIComponent(booking.id)}/status`, { status: next, show: tab.key }, ACTION_LABELS[next], next === "confirmed"));
  const sample = chrome.demo && isSample(booking);
  const remove = canDelete(booking) && !sample ? [action(`/studio/bookings/${encodeURIComponent(booking.id)}/delete`, { show: tab.key }, "Delete")] : [];
  const actions = [...moves, ...remove].join("");
  const mine = chrome.demo && !sample ? `<span class="tag">Your request</span>` : "";
  return `          <li class="booking" id="booking-${esc(booking.id)}">
            <div class="date-tile" aria-hidden="true"><span>${esc(when.dayName)}</span><strong>${esc(when.dayNumber)}</strong><span>${esc(when.month)}</span></div>
            <div class="booking-body">
              <div class="booking-top">
                <h2>${esc(booking.customer_name)}</h2>
                <span class="pill pill-${esc(booking.status)}">${STATUS_LABELS[booking.status]}</span>
                ${mine}
              </div>
              <p class="booking-when"><span class="visually-hidden">${esc(when.dateLong)}, </span>${esc(when.clock)} · ${esc(booking.service_name)} · ${booking.duration_minutes} min · ${formatPrice(booking.price_cents)}</p>
              <p class="booking-student">${esc(booking.student_details)}</p>
              ${booking.message ? `<p class="booking-message">“${esc(booking.message)}”</p>` : ""}
              <p class="booking-contact"><a href="${esc(mailto(booking.customer_email))}">${esc(booking.customer_email)}</a>${booking.customer_phone ? ` · <a href="tel:${esc(booking.customer_phone.replace(/[^\d+]/gu, ""))}">${esc(booking.customer_phone)}</a>` : ""}<span class="booking-received">Requested ${esc(timeAgo(requestedAt(booking), now))} · <span class="ref">${esc(booking.ref)}</span></span></p>
            </div>
            ${actions ? `<div class="booking-actions">${actions}</div>` : ""}
          </li>`;
}

export function lessonsPage({ services, errors = {}, form = {}, savedId, chrome, showStarter = false }) {
  const link = chrome.link;
  const saved = savedId ? services.find((service) => service.id === savedId) : null;
  const notice = saved ? `<p class="notice" role="status">Saved <strong>${esc(saved.name)}</strong>.</p>` : "";
  const cards = services
    .map((service) => {
      const values = form.id === service.id ? form : service;
      const fieldErrors = form.id === service.id ? errors : {};
      return `<li class="lesson-card" id="service-${esc(service.id)}">
            <form method="post" action="${esc(link(`/studio/lessons/${encodeURIComponent(service.id)}`))}" novalidate>
              <div class="lesson-card-head"><h2>${esc(service.name)}</h2>${service.active ? `<span class="pill pill-confirmed">On booking page</span>` : `<span class="pill pill-cancelled">Hidden</span>`}</div>
              ${lessonFields(service.id, values, fieldErrors)}
              <div class="lesson-card-foot"><button class="button button-small" type="submit">Save changes</button></div>
            </form>
          </li>`;
    })
    .join("\n");
  const addValues = form.id === "new" ? form : { active: true, duration_minutes: 45 };
  const addErrors = form.id === "new" ? errors : {};
  const starter = showStarter
    ? `<form class="starter" method="post" action="${esc(link("/studio/lessons/starter"))}"><p>No lessons yet. Start with four common lessons and edit them to suit your studio.</p><button class="button button-small" type="submit">Add starter lessons</button></form>`
    : "";
  return `      <div class="wrap studio-head">
        <div>
          <h1>Lessons</h1>
          <p class="lead">What students can book, how long it takes, and what it costs. Changes show on the booking page right away.</p>
        </div>
      </div>
      <div class="wrap">
        ${notice}${starter}
        <ul class="lesson-cards">
${cards}
        </ul>
        <section class="lesson-card add-card" id="service-new" aria-labelledby="add-lesson">
          <form method="post" action="${esc(link("/studio/lessons"))}" novalidate>
            <div class="lesson-card-head"><h2 id="add-lesson">Add a lesson</h2></div>
            ${lessonFields("new", addValues, addErrors)}
            <div class="lesson-card-foot"><button class="button button-small" type="submit">Add lesson</button></div>
          </form>
        </section>
      </div>`;
}

const LENGTH_OPTIONS = [20, 30, 45, 60, 90];

function lessonFields(id, values, errors) {
  const prefix = `lesson-${id}`;
  const price = values.price !== undefined ? values.price : values.price_cents !== undefined ? (values.price_cents / 100).toFixed(values.price_cents % 100 ? 2 : 0) : "";
  const errorFor = (name) => (errors[name] ? `<p class="field-error" id="${prefix}-${name}-error">${esc(errors[name])}</p>` : "");
  const invalid = (name) => (errors[name] ? ` aria-invalid="true" aria-describedby="${prefix}-${name}-error"` : "");
  return `<div class="lesson-fields">
                <div class="field field-wide"><label for="${prefix}-name">Name</label>${errorFor("name")}<input id="${prefix}-name" name="name" maxlength="60" required value="${esc(values.name)}"${invalid("name")}></div>
                <div class="field field-wide"><label for="${prefix}-summary">Description</label>${errorFor("summary")}<textarea id="${prefix}-summary" name="summary" maxlength="240" rows="2"${invalid("summary")}>${esc(values.summary)}</textarea></div>
                <div class="field"><label for="${prefix}-duration">Length</label>${errorFor("duration_minutes")}<select id="${prefix}-duration" name="duration_minutes"${invalid("duration_minutes")}>${LENGTH_OPTIONS.map((minutes) => `<option value="${minutes}"${Number(values.duration_minutes) === minutes ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></div>
                <div class="field"><label for="${prefix}-price">Price (USD)</label>${errorFor("price")}<input id="${prefix}-price" name="price" inputmode="decimal" maxlength="8" required value="${esc(price)}"${invalid("price")}></div>
                <div class="field field-check"><input id="${prefix}-active" name="active" type="checkbox" value="yes"${values.active ? " checked" : ""}><label for="${prefix}-active">Show on the booking page</label></div>
              </div>`;
}

export function activityPage({ entries, chrome, now }) {
  const items = entries.length
    ? entries
        .map(({ entry, booking }) => {
          const when = describeInstant(booking.starts_at);
          const fromCustomer = entry.by === "customer" || entry.by === "sample";
          const byName = entry.by && !fromCustomer && entry.by !== "owner" ? ` by ${esc(entry.by)}` : "";
          const label = entry.status === "new" && fromCustomer ? HISTORY_LABELS.new : `${entry.status === "new" ? "Moved back to new" : HISTORY_LABELS[entry.status]}${byName}`;
          return `<li class="activity-item activity-${esc(entry.status)}">
            <span class="activity-dot" aria-hidden="true"></span>
            <div>
              <p class="activity-what"><strong>${label}</strong>: <a href="${esc(chrome.link(`/studio?show=${tabFor(booking, now)}#booking-${booking.id}`))}">${esc(booking.customer_name)}</a>, ${esc(booking.service_name)} on ${esc(when.dayName)} ${esc(when.dayNumber)} ${esc(when.month)} at ${esc(when.clock)}</p>
              <p class="activity-when"><time datetime="${esc(entry.at)}">${esc(timeAgo(entry.at, now))}</time></p>
            </div>
          </li>`;
        })
        .join("\n")
    : `<li class="empty-state"><p>No activity yet.</p></li>`;
  return `      <div class="wrap studio-head">
        <div>
          <h1>Activity</h1>
          <p class="lead">The latest requests and status changes, newest first.</p>
        </div>
      </div>
      <div class="wrap activity-grid">
        <ol class="activity">
${items}
        </ol>
        <aside class="side-notes">
          <section>
            <h2>The full activity log</h2>
            <p>Each request, status change, and lesson edit is also written to your app's activity log in Userland, along with any errors. Open the app in your Userland dashboard, or ask your coding agent to check the log when something looks wrong.</p>
          </section>
          <section>
            <h2>Room for requests</h2>
            <p>The Free plan saves up to 1,000 items, and each request uses a few while its lesson is still to come. Every few months, clear out old requests from the Past lessons, Declined, and Cancelled tabs.</p>
          </section>
          <section>
            <h2>Visitor numbers</h2>
            <p>See visits, popular pages, and where visitors came from in the Userland dashboard's traffic view. Traffic analytics come with the Starter plan and up.</p>
          </section>
        </aside>
      </div>`;
}

export function forbiddenPage({ chrome }) {
  return messagePage({
    title: "This page is for the studio owner",
    text: "You're signed in, but this account can't open the studio desk. Ask the owner to invite you.",
    chrome
  });
}

/** Shown instead of saving a request when REQUEST_LIMITS (index.js) is reached. */
export function requestLimitPage({ reason, chrome }) {
  const text =
    reason === "email"
      ? `You already have a few requests waiting. ${STUDIO.teacher} will reply to those first. To ask about more times, email ${STUDIO.email}.`
      : `We have a lot of requests to answer right now, so online booking is paused. Please email ${STUDIO.email} and ${STUDIO.teacher} will find you a time.`;
  return messagePage({ title: reason === "email" ? "Your requests are on their way" : "Please email us to book", text, chrome });
}

/** Shown when the plan's storage is full and nothing new can be saved. */
export function storageFullPage({ owner, chrome }) {
  return owner
    ? messagePage({ title: "Storage is full", text: "Your plan's storage is full, so nothing new can be saved. Clear out old requests from the Past lessons, Declined, and Cancelled tabs to make room.", chrome, linkHref: "/studio?show=past", linkLabel: "Go to past lessons" })
    : messagePage({ title: "Online booking is paused", text: `We can't take new requests online right now. Please email ${STUDIO.email} and ${STUDIO.teacher} will find you a time.`, chrome });
}

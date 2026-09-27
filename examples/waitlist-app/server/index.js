// Velto waitlist: a pre-launch landing page with referral positions and an owner view.
//
// Public routes              Owner routes (app user with the "owner" role)
//   GET  /                     GET  /admin                  list, filters, stats, activity
//   POST /join                 GET  /admin/export.csv       download the filtered list
//   GET  /r/:code              POST /admin/signups/:id/status   invite, archive, restore
//   GET  /you/:id/:token       POST /admin/signups/:id/link     new private link
//   POST /you/:id/:token/answers  POST /admin/signups/:id/delete  delete an archived person
//   GET  /thanks               POST /admin/bulk             archive or delete many at once
//                              (sign in at /_userland/auth/login)
//
// Static files (CSS, fonts, icons, share.js) are served from public/ before this code runs.
//
// Demo mode lives in demo.js. Every line in this file that exists only for the
// public demo ends with `// demo`; deleting those lines and demo.js removes it
// (see "Demo mode" in README.md).

import {
  BULK_LIMIT,
  DuplicateSignupError,
  LIMITS,
  STATUSES,
  TRAP_FIELD,
  applyFilters,
  isValidId,
  joinWaitlist,
  normalizeCode,
  rankWaitlist,
  readFilters,
  recentActivity,
  reissueLink,
  safeEqual,
  signupStore,
  summarize,
  toCsv,
  topReferrers,
  validateAnswers,
  validateJoin
} from "./waitlist.js";
import { BRAND, landingPage, messagePage, ownerPage, pathWith, statusPage } from "./views.js";
import * as demoMode from "./demo.js"; // demo

const OWNER_ROLE = "owner";
const PRIVATE_ROBOTS = '<meta name="robots" content="noindex">';

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff"
};

function html(body, { status = 200, privatePage = false } = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": privatePage ? "no-store" : "no-cache",
      ...SECURITY_HEADERS
    }
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function message(site, options) {
  const page = messagePage({ site, ...options });
  return html(page.html, { status: page.status, privatePage: true });
}

// Page extras. In the public demo, `demo` is { key } for the visitor (null
// otherwise) and every page gets a banner, a footer note, and noindex.
function siteFor(demo, page, { privatePage = false, inviteHref } = {}) {
  if (demo) return demoMode.demoSite(demo, page, inviteHref); // demo
  return { robots: privatePage ? PRIVATE_ROBOTS : "" };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

// Rejects form posts sent from other websites, including other apps on
// *.apps.userland.fun (they count as the same site to the browser, so the
// sign-in cookie alone is not enough) and pages with an opaque "null" origin.
// Every form post in this app checks it before changing anything.
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

async function readForm(request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > LIMITS.body) return null;
  try {
    const form = await request.formData();
    const values = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") values[key] = value.slice(0, LIMITS.body);
    }
    return values;
  } catch {
    return null;
  }
}

// Owner pages need a signed-in app user with the owner role.
// Invite yourself once after publishing (see README), then sign in at /_userland/auth/login.
// One session lookup: the signed-in user carries their roles. Anything else
// that goes wrong (a storage error, say) is not hidden behind "Owners only".
async function requireOwner(request, ctx, returnTo) {
  const user = await ctx.auth.currentUser(request);
  if (!user) {
    return { response: redirect(`/_userland/auth/login?return_to=${encodeURIComponent(returnTo)}`) };
  }
  if (!Array.isArray(user.roles) || !user.roles.includes(OWNER_ROLE)) {
    return {
      response: message(siteFor(null, "other", { privatePage: true }), {
        title: "Owners only",
        heading: "This page is for the waitlist owner.",
        message: "You're signed in, but this account can't see the waitlist. Sign out and sign in with the owner account.",
        action: { href: "/_userland/auth/logout?return_to=%2Fadmin", label: "Sign out" },
        status: 403
      })
    };
  }
  return { user };
}

// Demo pages that aren't tied to a signup still get the demo banner and noindex
// tag, and keep the visitor's demo key when the link or form carried one.
function anyDemo(demoRequest, key) {
  if (demoRequest) return { key: demoMode.readDemoKey(key) }; // demo
  return null;
}

// Query values every link and form keeps: the visitor's demo key, in the demo.
function keepParams(demo) {
  if (demo) return demoMode.persistParams(demo.key); // demo
  return {};
}

// A link to `path` that keeps the visitor's demo key, if there is one.
function demoPath(path, demo) {
  return pathWith(path, {}, keepParams(demo));
}

// Picks where signups are read and saved: the real list, or this visitor's demo copy.
function openStore(ctx, demo) {
  if (demo) return demoMode.demoStore(ctx, demo.key); // demo
  return signupStore(ctx);
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

async function showLanding(url, ctx, demo, { values = {}, errors = {}, status = 200 } = {}) {
  const store = openStore(ctx, demo);
  const ref = values.ref ?? normalizeCode(url.searchParams.get("ref"));
  const referrer = ref ? await store.findByCode(ref) : null;
  const source = values.source ?? String(url.searchParams.get("utm_source") ?? "").slice(0, LIMITS.source);
  const page = landingPage({
    site: siteFor(demo, "landing"),
    values: { ...values, ref: referrer ? ref : "", source },
    errors,
    joined: await store.countJoined(),
    referrer,
    keep: keepParams(demo)
  });
  return html(page, { status });
}

async function handleJoin(request, url, ctx, demoRequest) {
  const form = await readForm(request);
  if (!form || !isSameOrigin(request, url)) {
    const demo = anyDemo(demoRequest, form?.demo);
    return message(siteFor(demo, "other"), {
      title: "Try again",
      heading: "That didn't go through.",
      message: "Please go back and send the form again.",
      action: { href: demoPath("/", demo), label: "Back to the waitlist" },
      status: 400
    });
  }

  let demo = null;
  if (demoRequest) demo = { key: demoMode.readDemoKey(form.demo) || demoMode.newDemoKey() }; // demo

  // Honeypot: people never see this field, so anything in it came from a bot.
  // Bots get the same answer as people, so they can't tell they were caught.
  // The warning lets the owner spot it if real people ever get caught too.
  if (form[TRAP_FIELD]) {
    await ctx.log.warn("waitlist signup ignored", { reason: "honeypot", demo: Boolean(demo) });
    return redirect(demoPath("/thanks", demo));
  }

  const { values, errors } = validateJoin(form);
  if (Object.keys(errors).length) return await showLanding(url, ctx, demo, { values, errors, status: 400 });

  try {
    const { signup, referrer } = await joinWaitlist(openStore(ctx, demo), values);
    // Visible to the owner in the Userland console and `userland apps events`. No personal details.
    await ctx.log.info("waitlist signup", { signup_id: signup.id, referred: Boolean(referrer), demo: Boolean(demo) });
    return redirect(`/you/${signup.id}/${signup.status_token}`);
  } catch (error) {
    if (error instanceof DuplicateSignupError) {
      // Same page as the honeypot rather than an "already on the list" error.
      // This only hides repeat emails: a new email still goes straight to its
      // private page, so the form still shows whether an address was new
      // (see "Spam and privacy" in README.md).
      return redirect(demoPath("/thanks", demo));
    }
    if (error?.code === "quota_exceeded") {
      // The plan's row limit is reached. Tell the visitor in plain words and
      // leave an error in the app's activity log so the owner notices.
      await ctx.log.error("waitlist full", { reason: "quota_exceeded", demo: Boolean(demo) });
      return message(siteFor(demo, "other"), {
        title: "Try again soon",
        heading: "The waitlist is full right now.",
        message: "We can't add anyone new at the moment. Please try again in a day or two.",
        action: { href: demoPath("/", demo), label: "Back to the waitlist" },
        status: 503
      });
    }
    if (error instanceof demoMode.DemoLimitError) return message(siteFor(demo, "other"), demoMode.limitMessage(error, demo, "Open the owner view")); // demo
    throw error;
  }
}

// Finds a signup by id and checks the private token from its link.
async function loadOwnSignup(ctx, demoRequest, id, token) {
  if (!isValidId(id) || !token || token.length > 64) return null;
  let demo = null;
  if (demoRequest) demo = { key: await demoMode.demoKeyForSignup(ctx, id) }; // demo
  const store = openStore(ctx, demo);
  const signup = await store.get(id);
  if (!signup || !safeEqual(token, signup.status_token)) return null;
  return { signup, store, demo };
}

function notFound(demo) {
  return message(siteFor(demo, "other", { privatePage: true }), {
    title: "Not found",
    heading: "We couldn't find that page.",
    message: "The link may be incomplete. Check it and try again, or head back to the waitlist.",
    action: { href: demoPath("/", demo), label: "Back to the waitlist" },
    status: 404
  });
}

async function showStatus(url, ctx, demoRequest, id, token) {
  const found = await loadOwnSignup(ctx, demoRequest, id, token);
  if (!found) return notFound(anyDemo(demoRequest, url.searchParams.get("demo")));
  const { store, demo } = found;
  const rows = await store.all();
  // The copy from the full list carries this person's referral count.
  const signup = rows.find((row) => row.id === found.signup.id) ?? found.signup;
  const { positions, waitingCount } = rankWaitlist(rows);
  let inviteHref;
  if (demo) inviteHref = pathWith("/", { ref: signup.referral_code }, keepParams(demo)); // demo
  const page = statusPage({
    site: siteFor(demo, "status", { privatePage: true, inviteHref }),
    signup,
    position: positions.get(signup.id),
    waitingCount,
    shareUrl: `${url.origin}/r/${signup.referral_code}`,
    statusPath: `/you/${signup.id}/${token}`,
    saved: url.searchParams.get("saved") === "1",
    // Lets a failed answers post still link back to this visitor's own demo.
    keep: keepParams(demo)
  });
  return html(page, { privatePage: true });
}

async function saveAnswers(request, url, ctx, demoRequest, id, token) {
  const form = await readForm(request);
  if (!form || !isSameOrigin(request, url)) return notFound(anyDemo(demoRequest, form?.demo));
  const found = await loadOwnSignup(ctx, demoRequest, id, token);
  if (!found) return notFound(anyDemo(demoRequest, form.demo));
  await found.store.update(found.signup.id, validateAnswers(form));
  await ctx.log.info("waitlist answers saved", { signup_id: found.signup.id });
  return redirect(`/you/${found.signup.id}/${token}?saved=1`);
}

// ---------------------------------------------------------------------------
// Owner view
// ---------------------------------------------------------------------------

async function loadOwnerData(store, url) {
  const rows = await store.all();
  const { positions } = rankWaitlist(rows);
  const filters = readFilters(url.searchParams);
  const filtered = applyFilters(rows, positions, filters);
  return { rows, positions, filters, filtered };
}

const DONE_NOTICES = { invited: "Marked as invited.", waiting: "Moved back to the line.", archived: "Archived.", deleted: "Deleted for good." };
const BULK_NOTICES = {
  "archived-many": (count) => `Archived ${count} ${count === 1 ? "person" : "people"}.`,
  "deleted-many": (count) => `Deleted ${count} ${count === 1 ? "person" : "people"} for good.`
};

// The note shown after a change. Only known values show anything, so
// ?done=constructor or ?done=__proto__ shows nothing.
function doneNotice(params) {
  const done = params.get("done") ?? "";
  if (Object.hasOwn(DONE_NOTICES, done)) return DONE_NOTICES[done];
  if (!Object.hasOwn(BULK_NOTICES, done)) return "";
  const count = Math.min(Math.max(Number.parseInt(params.get("n") ?? "0", 10) || 0, 0), BULK_LIMIT);
  const more = params.get("more") === "1" ? " More people match: press the button again to continue." : "";
  return `${BULK_NOTICES[done](count)}${more}`;
}

async function showOwner(request, url, ctx, demoRequest) {
  const demo = anyDemo(demoRequest, url.searchParams.get("demo")); // The demo skips sign-in.
  let user = null;
  if (!demo) {
    const gate = await requireOwner(request, ctx, pathWith(url.pathname, Object.fromEntries(url.searchParams)));
    if (gate.response) return gate.response;
    user = gate.user;
  }
  const { rows, positions, filters, filtered } = await loadOwnerData(openStore(ctx, demo), url);
  const page = ownerPage({
    site: siteFor(demo, "owner", { privatePage: true }),
    rows: filtered,
    total: filtered.length,
    filters,
    positions,
    stats: summarize(rows),
    referrers: topReferrers(rows),
    activity: recentActivity(rows),
    keep: keepParams(demo),
    user,
    notice: doneNotice(url.searchParams),
    bulkLimit: BULK_LIMIT
  });
  return html(page, { privatePage: true });
}

async function exportCsv(request, url, ctx, demoRequest) {
  const demo = anyDemo(demoRequest, url.searchParams.get("demo")); // The demo skips sign-in.
  if (!demo) {
    const gate = await requireOwner(request, ctx, "/admin");
    if (gate.response) return gate.response;
  }
  const { positions, filtered } = await loadOwnerData(openStore(ctx, demo), url);
  await ctx.log.info("waitlist exported", { rows: filtered.length });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(filtered, positions), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="velto-waitlist-${day}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

// Every owner form post starts here: a same-site check, the visitor's demo key
// in the demo, and the owner sign-in check everywhere else.
// Returns { form, demo } or { response } to send back as is.
async function ownerPost(request, url, ctx, demoRequest, isValid) {
  const form = await readForm(request);
  if (!form || !isSameOrigin(request, url) || !isValid(form)) {
    const demo = anyDemo(demoRequest, form?.demo);
    return {
      response: message(siteFor(demo, "owner", { privatePage: true }), {
        title: "Try again",
        heading: "That change didn't go through.",
        message: "Go back to the owner view and try again.",
        action: { href: demoPath("/admin", demo), label: "Back to the owner view" },
        status: 400
      })
    };
  }
  // The demo skips sign-in. A visitor who hasn't joined yet gets a demo key on their first change.
  let demo = null;
  if (demoRequest) demo = { key: demoMode.readDemoKey(form.demo) || demoMode.newDemoKey() }; // demo
  if (!demo) {
    const gate = await requireOwner(request, ctx, "/admin");
    if (gate.response) return gate;
  }
  return { form, demo };
}

// Back to the owner view the change was made from, with a note about what happened.
function backToOwner(form, url, demo, notice) {
  const back = typeof form.back === "string" && /^\/admin(\?|$)/u.test(form.back) ? form.back : "/admin";
  const next = new URL(back, url.origin);
  for (const key of ["done", "n", "more"]) next.searchParams.delete(key);
  for (const [key, value] of Object.entries(notice)) next.searchParams.set(key, String(value));
  if (demo) next.searchParams.set("demo", demo.key); // demo
  return redirect(`${next.pathname}${next.search}`);
}

// Turns a demo limit into its friendly page; anything else is rethrown.
function ownerFailure(error, demo) {
  if (error instanceof demoMode.DemoLimitError) return message(siteFor(demo, "owner", { privatePage: true }), demoMode.limitMessage(error, demo, "Back to the owner view")); // demo
  throw error;
}

async function changeStatus(request, url, ctx, demoRequest, id) {
  const posted = await ownerPost(request, url, ctx, demoRequest, (form) => isValidId(id) && STATUSES.includes(form.status));
  if (posted.response) return posted.response;
  const { form, demo } = posted;

  const store = openStore(ctx, demo);
  const current = await store.get(id);
  if (!current) return notFound(demo);
  const patch = { status: form.status, ...(form.status === "invited" ? { invited_at: new Date().toISOString() } : {}) };
  let updated;
  try {
    updated = await store.update(current.id, patch);
  } catch (error) {
    return ownerFailure(error, demo);
  }
  await ctx.log.info("waitlist status changed", { signup_id: updated.id, status: updated.status });
  return backToOwner(form, url, demo, { done: updated.status });
}

// Deletes one person for good. Only archived people can be deleted, so it
// always takes two clicks (Archive, then Delete) to lose someone.
async function deleteSignup(request, url, ctx, demoRequest, id) {
  const posted = await ownerPost(request, url, ctx, demoRequest, () => isValidId(id));
  if (posted.response) return posted.response;
  const { form, demo } = posted;

  const store = openStore(ctx, demo);
  const current = await store.get(id);
  if (!current) return notFound(demo);
  if (current.status !== "archived") {
    return message(siteFor(demo, "owner", { privatePage: true }), {
      title: "Archive first",
      heading: "Archive this person first.",
      message: "Only archived people can be deleted. Archive them, then delete them from the Archived list.",
      action: { href: demoPath("/admin", demo), label: "Back to the owner view" },
      status: 409
    });
  }
  try {
    await store.remove(current.id);
  } catch (error) {
    return ownerFailure(error, demo);
  }
  await ctx.log.info("waitlist signup deleted", { signup_id: current.id });
  return backToOwner(form, url, demo, { done: "deleted" });
}

// Makes a new private link for someone and shows it to the owner to send on.
// Use it when a person lost their link, or when someone else joined with
// their email first: the old link stops working at once.
async function newPrivateLink(request, url, ctx, demoRequest, id) {
  const posted = await ownerPost(request, url, ctx, demoRequest, () => isValidId(id));
  if (posted.response) return posted.response;
  const { demo } = posted;

  const store = openStore(ctx, demo);
  const current = await store.get(id);
  if (!current) return notFound(demo);
  let updated;
  try {
    updated = await reissueLink(store, current.id);
  } catch (error) {
    return ownerFailure(error, demo);
  }
  await ctx.log.info("waitlist private link replaced", { signup_id: updated.id });
  return message(siteFor(demo, "owner", { privatePage: true }), {
    title: "New private link",
    heading: "Here's their new private link.",
    message: `Send it to ${updated.email} yourself. Their old link no longer works. This page won't show the link again.`,
    copyValue: `${url.origin}/you/${updated.id}/${updated.status_token}`,
    action: { href: demoPath("/admin", demo), label: "Back to the owner view" }
  });
}

// Archives, or deletes, the people that match the owner's current filters,
// BULK_LIMIT at a time. Archiving needs a search or filter, so one click can't
// empty the whole list. Deleting only ever touches archived people.
async function bulkChange(request, url, ctx, demoRequest) {
  const posted = await ownerPost(request, url, ctx, demoRequest, (form) => form.action === "archive" || form.action === "delete");
  if (posted.response) return posted.response;
  const { form, demo } = posted;

  const filters = readFilters(new URLSearchParams(Object.entries(form).filter(([key]) => ["q", "status", "frequency", "goal"].includes(key))));
  const narrowed = Boolean(filters.q || filters.status || filters.frequency || filters.goal);
  if (form.action === "archive" && !narrowed) {
    return message(siteFor(demo, "owner", { privatePage: true }), {
      title: "Pick who first",
      heading: "Search or filter first.",
      message: "Archiving many people at once only works on a search or filter, so the whole list can't be archived by accident.",
      action: { href: demoPath("/admin", demo), label: "Back to the owner view" },
      status: 400
    });
  }

  const store = openStore(ctx, demo);
  const rows = await store.all();
  const { positions } = rankWaitlist(rows);
  const matches = applyFilters(rows, positions, filters);
  const targets = matches.filter((row) => (form.action === "archive" ? row.status !== "archived" : row.status === "archived"));
  const batch = targets.slice(0, BULK_LIMIT);
  try {
    // One at a time, so a busy list doesn't get dozens of writes at the same instant.
    for (const row of batch) {
      try {
        if (form.action === "archive") await store.update(row.id, { status: "archived" });
        else await store.remove(row.id);
      } catch (error) {
        // Already deleted by another click a moment ago: nothing left to do.
        if (error?.code !== "not_found") throw error;
      }
    }
  } catch (error) {
    return ownerFailure(error, demo);
  }
  await ctx.log.info("waitlist bulk change", { action: form.action, count: batch.length });
  const done = form.action === "archive" ? "archived-many" : "deleted-many";
  return backToOwner(form, url, demo, { done, n: batch.length, ...(targets.length > batch.length ? { more: 1 } : {}) });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const app = {
  async fetch(request, ctx) {
    if (request.method === "HEAD") return await answerHead(request, ctx, app.fetch);
    const url = new URL(request.url);
    let demoRequest = false;
    demoRequest = demoMode.isDemoRequest(url); // demo
    const method = request.method;
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    const statusMatch = path.match(/^\/you\/([^/]+)\/([^/]+)(\/answers)?$/u);
    const ownerAction = path.match(/^\/admin\/signups\/([^/]+)\/(status|link|delete)$/u);
    const refMatch = path.match(/^\/r\/([^/]+)$/u);

    if (path === "/" && method === "GET") {
      return await showLanding(url, ctx, anyDemo(demoRequest, url.searchParams.get("demo")));
    }
    if (path === "/join" && method === "POST") return await handleJoin(request, url, ctx, demoRequest);
    if (refMatch && method === "GET") {
      // Codes only use A-Z and 2-9, so there is nothing to decode.
      const code = normalizeCode(refMatch[1]);
      return redirect(code ? `/?ref=${code}` : "/");
    }
    if (statusMatch && !statusMatch[3] && method === "GET") return await showStatus(url, ctx, demoRequest, statusMatch[1], statusMatch[2]);
    if (statusMatch && statusMatch[3] && method === "POST") return await saveAnswers(request, url, ctx, demoRequest, statusMatch[1], statusMatch[2]);
    if (path === "/thanks" && method === "GET") {
      // Shown when an email is already on the list (and to bots caught by the honeypot).
      const demo = anyDemo(demoRequest, url.searchParams.get("demo"));
      return message(siteFor(demo, "other"), {
        title: "Thanks",
        heading: "Thanks, you're on the list.",
        message: `We'll be in touch when early access opens. If you joined before, your spot is still saved: open the private link from your first visit to see your place in line. Lost it? Email ${BRAND.contactEmail} and we'll send you a new one.`,
        action: { href: demoPath("/", demo), label: "Back to the waitlist" }
      });
    }
    if (path === "/admin" && method === "GET") return await showOwner(request, url, ctx, demoRequest);
    if (path === "/admin/export.csv" && method === "GET") return await exportCsv(request, url, ctx, demoRequest);
    if (ownerAction && method === "POST") {
      const [, id, action] = ownerAction;
      if (action === "status") return await changeStatus(request, url, ctx, demoRequest, id);
      if (action === "link") return await newPrivateLink(request, url, ctx, demoRequest, id);
      return await deleteSignup(request, url, ctx, demoRequest, id);
    }
    if (path === "/admin/bulk" && method === "POST") return await bulkChange(request, url, ctx, demoRequest);

    return notFound(anyDemo(demoRequest, url.searchParams.get("demo")));
  }
};

export default app;

// Velto waitlist: a pre-launch landing page with referral positions and an owner view.
//
// Public routes              Owner routes (app user with the "owner" role)
//   GET  /                     GET  /admin                  list, filters, stats, activity
//   POST /join                 GET  /admin/export.csv       download the filtered list
//   GET  /r/:code              POST /admin/signups/:id/status
//   GET  /you/:id/:token       (sign in at /_userland/auth/login)
//   POST /you/:id/:token/answers
//   GET  /thanks
//
// Static files (CSS, fonts, icons, share.js) are served from public/ before this code runs.

import {
  DuplicateSignupError,
  LIMITS,
  STATUSES,
  applyFilters,
  isValidId,
  joinWaitlist,
  normalizeCode,
  rankWaitlist,
  readFilters,
  recentActivity,
  safeEqual,
  signupStore,
  summarize,
  toCsv,
  topReferrers,
  validateAnswers,
  validateJoin
} from "./waitlist.js";
import { landingPage, messagePage, ownerPage, pathWith, statusPage } from "./views.js";
// Demo mode: delete this import and the `if (demo)` branches below to remove it.
import {
  DemoLimitError,
  demoBanner,
  demoFooter,
  demoShareNote,
  demoKeyForSignup,
  demoStore,
  isDemoRequest,
  newDemoKey,
  persistParams,
  readDemoKey,
  robotsMeta
} from "./demo.js";

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

// Page extras: the demo adds a banner, a footer note, and noindex on every page,
// and keeps the visitor's demo key on the logo link.
function siteFor(demo, page, { privatePage = false, inviteHref } = {}) {
  if (demo) {
    return {
      robots: robotsMeta(),
      banner: demoBanner({ page, key: demo.key, inviteHref }),
      footer: demoFooter(),
      home: pathWith("/", {}, persistParams(demo.key)),
      shareNote: inviteHref ? demoShareNote(inviteHref) : ""
    };
  }
  return { robots: privatePage ? PRIVATE_ROBOTS : "" };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

// Rejects form posts sent from other websites.
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
async function requireOwner(request, ctx, returnTo) {
  const user = await ctx.auth.currentUser(request);
  if (!user) {
    return { response: redirect(`/_userland/auth/login?return_to=${encodeURIComponent(returnTo)}`) };
  }
  try {
    return { user: await ctx.auth.requireRole(request, OWNER_ROLE) };
  } catch {
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
}

// Demo pages that aren't tied to a signup still get the demo banner and noindex
// tag, and keep the visitor's demo key when the link or form carried one.
function anyDemo(demoRequest, key) {
  return demoRequest ? { key: readDemoKey(key) } : null;
}

// A link to `path` that keeps the visitor's demo key, if there is one.
function demoPath(path, demo) {
  return pathWith(path, {}, demo ? persistParams(demo.key) : {});
}

// Picks where signups are read and saved: the real list, or this visitor's demo copy.
function openStore(ctx, demo) {
  if (demo) return demoStore(ctx, demo.key);
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
    keep: demo ? persistParams(demo.key) : {}
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

  // Demo: keep adding to this visitor's demo list, or start a new one.
  const demo = demoRequest ? { key: readDemoKey(form.demo) || newDemoKey() } : null;

  // Honeypot: people never see this field, so anything in it came from a bot.
  // Bots get the same answer as people, so they can't tell they were caught.
  if (form.company) return redirect(demoPath("/thanks", demo));

  const { values, errors } = validateJoin(form);
  if (Object.keys(errors).length) return await showLanding(url, ctx, demo, { values, errors, status: 400 });

  try {
    const { signup, referrer } = await joinWaitlist(openStore(ctx, demo), values);
    // Visible to the owner in the Userland console and `userland apps events`. No personal details.
    await ctx.log.info("waitlist signup", { signup_id: signup.id, referred: Boolean(referrer), demo: Boolean(demo) });
    return redirect(`/you/${signup.id}/${signup.status_token}`);
  } catch (error) {
    if (error instanceof DuplicateSignupError) {
      // Same neutral page as the honeypot, not an "already on the list" error,
      // so the form can't be used to check whether someone's email signed up.
      return redirect(demoPath("/thanks", demo));
    }
    if (error instanceof DemoLimitError) {
      return message(siteFor(demo, "other"), {
        title: "Demo limit",
        heading: error.heading,
        message: error.message,
        action: { href: pathWith("/admin", {}, persistParams(demo.key)), label: "Open the owner view" },
        status: 429
      });
    }
    throw error;
  }
}

// Finds a signup by id and checks the private token from its link.
async function loadOwnSignup(ctx, demoRequest, id, token) {
  if (!isValidId(id) || !token || token.length > 64) return null;
  const demo = demoRequest ? { key: await demoKeyForSignup(ctx, id) } : null;
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
  const inviteHref = demo ? pathWith("/", { ref: signup.referral_code }, persistParams(demo.key)) : undefined;
  const page = statusPage({
    site: siteFor(demo, "status", { privatePage: true, inviteHref }),
    signup,
    position: positions.get(signup.id),
    waitingCount,
    shareUrl: `${url.origin}/r/${signup.referral_code}`,
    statusPath: `/you/${signup.id}/${token}`,
    saved: url.searchParams.get("saved") === "1",
    // Lets a failed answers post still link back to this visitor's own demo.
    keep: demo ? persistParams(demo.key) : {}
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

const DONE_NOTICES = { invited: "Marked as invited.", waiting: "Moved back to the line.", archived: "Archived." };

async function showOwner(request, url, ctx, demoRequest) {
  let demo = null;
  let user = null;
  if (demoRequest) {
    demo = { key: readDemoKey(url.searchParams.get("demo")) };
  } else {
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
    keep: demo ? persistParams(demo.key) : {},
    user,
    notice: DONE_NOTICES[url.searchParams.get("done")] ?? ""
  });
  return html(page, { privatePage: true });
}

async function exportCsv(request, url, ctx, demoRequest) {
  let demo = null;
  if (demoRequest) {
    demo = { key: readDemoKey(url.searchParams.get("demo")) };
  } else {
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

async function changeStatus(request, url, ctx, demoRequest, id) {
  const form = await readForm(request);
  if (!form || !isSameOrigin(request, url) || !isValidId(id) || !STATUSES.includes(form.status)) {
    const demo = anyDemo(demoRequest, form?.demo);
    return message(siteFor(demo, "owner", { privatePage: true }), {
      title: "Try again",
      heading: "That change didn't go through.",
      message: "Go back to the owner view and try again.",
      action: { href: demoPath("/admin", demo), label: "Back to the owner view" },
      status: 400
    });
  }
  let demo = null;
  if (demoRequest) {
    // A visitor who hasn't joined yet gets a demo key on their first change.
    demo = { key: readDemoKey(form.demo) || newDemoKey() };
  } else {
    const gate = await requireOwner(request, ctx, "/admin");
    if (gate.response) return gate.response;
  }

  const store = openStore(ctx, demo);
  const current = await store.get(id);
  if (!current) return notFound(demo);
  const patch = { status: form.status, ...(form.status === "invited" ? { invited_at: new Date().toISOString() } : {}) };
  let updated;
  try {
    updated = await store.update(current.id, patch);
  } catch (error) {
    if (error instanceof DemoLimitError) {
      return message(siteFor(demo, "owner", { privatePage: true }), {
        title: "Demo limit",
        heading: error.heading,
        message: error.message,
        action: { href: demoPath("/admin", demo), label: "Back to the owner view" },
        status: 429
      });
    }
    throw error;
  }
  await ctx.log.info("waitlist status changed", { signup_id: updated.id, status: updated.status });

  const back = typeof form.back === "string" && /^\/admin(\?|$)/u.test(form.back) ? form.back : "/admin";
  const next = new URL(back, url.origin);
  next.searchParams.set("done", updated.status);
  if (demo) next.searchParams.set("demo", demo.key);
  return redirect(`${next.pathname}${next.search}`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, ctx) {
    const url = new URL(request.url);
    const demoRequest = isDemoRequest(url);
    const method = request.method;
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    const statusMatch = path.match(/^\/you\/([^/]+)\/([^/]+)(\/answers)?$/u);
    const statusChange = path.match(/^\/admin\/signups\/([^/]+)\/status$/u);
    const refMatch = path.match(/^\/r\/([^/]+)$/u);

    if (path === "/" && method === "GET") {
      const demo = demoRequest ? { key: readDemoKey(url.searchParams.get("demo")) } : null;
      return await showLanding(url, ctx, demo);
    }
    if (path === "/join" && method === "POST") return await handleJoin(request, url, ctx, demoRequest);
    if (refMatch && method === "GET") {
      const code = normalizeCode(decodeURIComponent(refMatch[1]));
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
        message: "We'll be in touch when early access opens. If you joined before, your spot is still saved: open the private link from your first visit to see your place in line.",
        action: { href: demoPath("/", demo), label: "Back to the waitlist" }
      });
    }
    if (path === "/admin" && method === "GET") return await showOwner(request, url, ctx, demoRequest);
    if (path === "/admin/export.csv" && method === "GET") return await exportCsv(request, url, ctx, demoRequest);
    if (statusChange && method === "POST") return await changeStatus(request, url, ctx, demoRequest, statusChange[1]);

    return notFound(anyDemo(demoRequest, url.searchParams.get("demo")));
  }
};

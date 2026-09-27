// Mini CRM: a lead inbox for a small renovation business.
//
// Public routes
//   GET  /                        Estimate request form
//   POST /estimate                Save a request as a new lead
//   GET  /thanks                  Confirmation
// Owner routes (app user with the "owner" role)
//   GET  /admin                   Lead board: stats, stage filter, pages, recent activity
//   GET  /admin/leads/new         Add a lead by hand
//   POST /admin/leads             Save it
//   GET  /admin/leads/:id         Lead detail and history
//   POST /admin/leads/:id/stage   Change stage and follow-up date
//   POST /admin/leads/:id/notes   Add a note
//   POST /admin/leads/:id/delete  Delete the lead and its history
//
// Userland docs: https://docs.userland.fun/llms.txt

import { demo } from "./demo.js"; // Public demo only. See server/demo.js to remove it.
import { STAGES, createStore, validateLead, validateNote, validateUpdate } from "./leads.js";
import { BUSINESS, boardPage, homePage, leadPage, messagePage, newLeadPage, thanksPage } from "./views.js";

const OWNER_ROLE = "owner";
const MAX_FORM_BYTES = 16 * 1024;
const CURSOR_PATTERN = /^[A-Za-z0-9+/=_-]{1,200}$/;

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff"
};

function html(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS }
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

/**
 * Read the request body, giving up past `max` bytes. Content-Length can be
 * missing (a chunked upload), so count the bytes as they arrive instead of
 * trusting the header. Returns null when the body is too large.
 */
async function readBody(request, max) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read a urlencoded or multipart form into a plain object of strings.
 * Returns { values } or { status } when the form can't be read.
 */
async function readForm(request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) return { status: 400 };
  const bytes = await readBody(request, MAX_FORM_BYTES);
  if (!bytes) return { status: 413 };
  let form;
  try {
    form = await new Response(bytes, { headers: { "content-type": type } }).formData();
  } catch {
    return { status: 400 };
  }
  const values = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") values[name] = value.slice(0, 4000);
  }
  return { values };
}

/**
 * Reject form posts sent from other sites, including other apps on
 * *.apps.userland.fun (they count as the same site for cookies, so the owner's
 * sign-in cookie rides along). Browsers send Origin on POST; when it's
 * missing, fall back to Sec-Fetch-Site, then to Referer (these pages send
 * Referer to their own origin). With none of the three, `allowUnknown` decides:
 * true for the public form (curl and old clients may post it), false for the
 * owner routes.
 */
function isSameOrigin(request, url, { allowUnknown }) {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === url.origin; // "null" and other hosts fail
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }
  return allowUnknown;
}

/**
 * Owner gate. Returns null when the request may continue, or the response to
 * send instead. In demo mode anyone can look around (see server/demo.js).
 */
async function requireOwner(request, ctx, url, rc) {
  if (rc.demo) return null;
  const user = await ctx.auth.currentUser(request);
  if (!user) {
    if (request.method === "GET") {
      return redirect(`/_userland/auth/login?return_to=${encodeURIComponent(url.pathname + url.search)}`);
    }
    return html(messagePage(rc, { title: "Please sign in", message: "Your session ended. Sign in again to keep working.", action: { href: "/_userland/auth/login?return_to=/admin", label: "Sign in" } }), 401);
  }
  if (!user.roles.includes(OWNER_ROLE)) {
    return html(messagePage(rc, { title: "Owner access only", message: "This account can't open the lead board. Ask the owner to invite you.", action: { href: "/_userland/auth/logout", label: "Sign out" } }), 403);
  }
  rc.user = user;
  return null;
}

/**
 * Per-request context for views: whether this is the demo, the visitor's demo
 * key (if any), the signed-in owner, and href() to keep the key on every link.
 */
function requestContext(url, form, demoMode) {
  const key = demoMode ? demoMode.keyFrom(url, form) : "";
  return {
    demo: Boolean(demoMode),
    demoKeepHours: demoMode?.keepHours ?? 0,
    key,
    user: null,
    page: "",
    href(path) {
      if (!this.key) return path;
      return `${path}${path.includes("?") ? "&" : "?"}demo=${encodeURIComponent(this.key)}`;
    }
  };
}

/** The store for this request: real data, or this visitor's demo view. */
function openStore(ctx, rc, demoMode, { forWrite = false } = {}) {
  if (!demoMode) return createStore(ctx);
  if (forWrite && !rc.key) rc.key = demoMode.newKey();
  return demoMode.openStore(ctx, rc.key);
}

function notFound(rc, area = "public") {
  return html(messagePage(rc, { title: "Page not found", message: "That page doesn't exist or was moved.", area, action: { href: rc.href(area === "owner" ? "/admin" : "/"), label: area === "owner" ? "Back to leads" : "Back to the home page" } }), 404);
}

/** One page of leads. A cursor that no longer works starts again from the newest. */
async function leadPageOf(store, { stage, cursor }) {
  if (!cursor) return await store.listLeads({ stage });
  try {
    return await store.listLeads({ stage, cursor });
  } catch {
    return await store.listLeads({ stage });
  }
}

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The page for an error we expect, or null. See the catch in createApp(). */
function expectedErrorPage(error, rc, path) {
  const call = `call us at ${BUSINESS.phone}`;
  // server/leads.js: the public form's limits (REQUEST_LIMITS).
  if (error?.code === "request_limit") {
    return error.scope === "email"
      ? { status: 429, title: "We already have your request", message: `We've received a few requests from this email address today. A crew lead will be in touch within one business day. If it's urgent, ${call}.`, action: { href: rc.href("/"), label: "Back to the home page" } }
      : { status: 429, title: "We're getting a lot of requests", message: `Our online form is taking a short break. Please ${call}, or try again later.`, action: { href: rc.href("/"), label: "Back to the home page" } };
  }
  // server/demo.js: the public demo's limits.
  if (error?.code === "demo_limit") {
    if (error.scope === "sample") return { status: 422, area: "owner", title: "Sample leads stay in the demo", message: "You can delete leads you add yourself. The sample leads stay so every visitor has something to look at.", action: { href: rc.href("/admin"), label: "Back to leads" } };
    if (error.scope === "everyone") return { status: 429, title: "The demo is busy", message: "This demo takes a limited number of new entries each hour, and it has taken them all for now. You can still look around the lead board and the sample leads, or try again later.", action: { href: rc.href("/admin"), label: "Open the lead board" } };
    return { status: 429, title: "That's plenty for a demo", message: "This demo has saved as many entries as it can for you. Start fresh from the home page to keep exploring.", action: { href: "/", label: "Start fresh" } };
  }
  // The platform refuses new data rows once the app has used its plan's rows.
  if (error?.code === "quota_exceeded") {
    if (rc.demo) return { status: 503, title: "The demo is full for now", message: "This demo can't save anything new right now. You can still look around the lead board and the sample leads.", action: { href: rc.href("/admin"), label: "Open the lead board" } };
    if (path === "/estimate") return { status: 503, title: "We can't take requests online right now", message: `Please ${call} and we'll take your details over the phone.`, action: { href: "/", label: "Back to the home page" } };
    return { status: 503, area: "owner", title: "Your lead board is full", message: "The app has used all the storage its plan includes, so it can't save this change. Delete old or spam leads to make room, or move the app to a bigger plan.", action: { href: "/admin", label: "Back to leads" } };
  }
  return null;
}

/**
 * createApp() returns the Userland server module. Pass `{ demo }` from
 * server/demo.js to allow demo mode; it then turns on only for requests to
 * the public demo's addresses (DEMO_HOSTS in server/demo.js). Everywhere else
 * the owner routes require a signed-in owner.
 */
export function createApp({ demo = null } = {}) {
  const demoFor = (url) => (demo?.activeFor(url) ? demo : null);

  async function handle(request, ctx, state) {
    const url = new URL(request.url);
    const demoMode = demoFor(url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isPost = request.method === "POST";
    const isRead = request.method === "GET";

    let form = {};
    if (isPost) {
      if (!isSameOrigin(request, url, { allowUnknown: path === "/estimate" })) return new Response("Forbidden", { status: 403 });
      const read = await readForm(request);
      if (!read.values) return new Response(read.status === 413 ? "Form too large" : "Unsupported form submission", { status: read.status });
      form = read.values;
    }
    const rc = requestContext(url, form, demoMode);
    state.rc = rc;

    // ---- Public -----------------------------------------------------------
    if (path === "/" && isRead) return html(homePage(rc));

    if (path === "/estimate" && isPost) {
      if (form.website) return redirect("/thanks"); // Honeypot filled: a bot. Drop it quietly.
      const { values, errors } = validateLead(form, "public");
      if (Object.keys(errors).length > 0) return html(homePage(rc, { values, errors }), 422);
      const store = openStore(ctx, rc, demoMode, { forWrite: true });
      const lead = await store.createLead(values, { via: "public" });
      await ctx.log.info("lead received", { lead_id: lead.id, project: lead.project, demo: rc.demo });
      return redirect(rc.href("/thanks"));
    }

    if (path === "/thanks" && isRead) return html(thanksPage(rc));

    if (!path.startsWith("/admin")) return notFound(rc);

    // ---- Owner ------------------------------------------------------------
    const denied = await requireOwner(request, ctx, url, rc);
    if (denied) return denied;

    if (path === "/admin" && isRead) {
      const stageParam = url.searchParams.get("stage") ?? "";
      const stage = STAGES.some((option) => option.value === stageParam) ? stageParam : "";
      const afterParam = url.searchParams.get("after") ?? "";
      const after = CURSOR_PATTERN.test(afterParam) ? afterParam : "";
      const now = new Date();
      const store = openStore(ctx, rc, demoMode);
      const [page, summary, activity] = await Promise.all([leadPageOf(store, { stage, cursor: after }), store.summarize(now), store.recentActivity(8)]);
      rc.page = "board";
      return html(boardPage(rc, { leads: page.leads, cursor: page.cursor, after, summary, activity, stage, now, saved: url.searchParams.get("saved") ?? "" }));
    }

    if (path === "/admin/leads/new" && isRead) {
      rc.page = "new";
      return html(newLeadPage(rc));
    }

    if (path === "/admin/leads" && isPost) {
      const { values, errors } = validateLead(form, "owner");
      if (Object.keys(errors).length > 0) {
        rc.page = "new";
        return html(newLeadPage(rc, { values, errors }), 422);
      }
      const store = openStore(ctx, rc, demoMode, { forWrite: true });
      const lead = await store.createLead(values, { via: "owner" });
      await ctx.log.info("lead added", { lead_id: lead.id, source: lead.source, demo: rc.demo });
      return redirect(rc.href(`/admin/leads/${encodeURIComponent(lead.id)}?saved=created`));
    }

    const match = path.match(/^\/admin\/leads\/([A-Za-z0-9_-]{1,64})(\/stage|\/notes|\/delete)?$/);
    if (!match) return notFound(rc, "owner");
    const [, leadId, action] = match;

    if (!action && isRead) {
      const store = openStore(ctx, rc, demoMode);
      const lead = await store.getLead(leadId);
      if (!lead) return notFound(rc, "owner");
      const history = await store.leadHistory(leadId);
      return html(leadPage(rc, { lead, history, now: new Date(), saved: url.searchParams.get("saved") ?? "" }));
    }

    if (action && isPost) {
      // A visitor's first save in the demo gets a new key, so look the lead up
      // with the store that will do the write.
      const store = openStore(ctx, rc, demoMode, { forWrite: true });
      const lead = await store.getLead(leadId);
      if (!lead) return notFound(rc, "owner");
      const showLead = async (extra, status) => html(leadPage(rc, { lead, history: await store.leadHistory(leadId), now: new Date(), ...extra }), status);

      if (action === "/stage") {
        const { values, errors } = validateUpdate(form);
        if (Object.keys(errors).length > 0) return await showLead({ updateErrors: errors }, 422);
        const updated = await store.updateLead(lead, values);
        if (updated.stage !== lead.stage) {
          await ctx.log.info("lead stage changed", { lead_id: lead.id, from: lead.stage, to: updated.stage, demo: rc.demo });
        }
        return redirect(rc.href(`/admin/leads/${encodeURIComponent(lead.id)}?saved=update`));
      }

      if (action === "/delete") {
        if (form.confirm !== "yes") return await showLead({ deleteErrors: { confirm: "Tick the box to confirm you want to delete this lead." } }, 422);
        const { done } = await store.deleteLead(lead);
        await ctx.log.info("lead deleted", { lead_id: lead.id, done, demo: rc.demo });
        return redirect(done ? rc.href("/admin?saved=deleted") : rc.href(`/admin/leads/${encodeURIComponent(lead.id)}?saved=deleting`));
      }

      const { values, errors } = validateNote(form);
      if (Object.keys(errors).length > 0) return await showLead({ noteErrors: errors, noteValues: values }, 422);
      await store.addNote(lead, values.body);
      await ctx.log.info("lead note added", { lead_id: lead.id, demo: rc.demo });
      return redirect(rc.href(`/admin/leads/${encodeURIComponent(lead.id)}?saved=note`));
    }

    return new Response("Method not allowed", { status: 405 });
  }

  const app = {
    async fetch(request, ctx) {
      if (request.method === "HEAD") return await answerHead(request, ctx, app.fetch);
      const url = new URL(request.url);
      const state = {};
      try {
        return await handle(request, ctx, state);
      } catch (error) {
        const path = url.pathname.replace(/\/+$/, "") || "/";
        // The request's context when it got that far, so links keep a demo key.
        const rc = state.rc ?? requestContext(url, {}, demoFor(url));
        const page = expectedErrorPage(error, rc, path);
        if (page) {
          if (error.code === "quota_exceeded") await ctx.log.error("data row limit reached", { path, demo: rc.demo });
          if (error.code === "request_limit") await ctx.log.warn("request form limit reached", { scope: error.scope });
          return html(messagePage(rc, page), page.status);
        }
        await ctx.log.error("request failed", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
        return html(messagePage(rc, { title: "Something went wrong", message: "We couldn't finish that. Please try again in a minute." }), 500);
      }
    }
  };
  return app;
}

export default createApp({ demo });

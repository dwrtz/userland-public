// Mini CRM: a lead inbox for a small renovation business.
//
// Public routes
//   GET  /                        Estimate request form
//   POST /estimate                Save a request as a new lead
//   GET  /thanks                  Confirmation
// Owner routes (app user with the "owner" role)
//   GET  /admin                   Lead board: stats, stage filter, recent activity
//   GET  /admin/leads/new         Add a lead by hand
//   POST /admin/leads             Save it
//   GET  /admin/leads/:id         Lead detail and history
//   POST /admin/leads/:id/stage   Change stage and follow-up date
//   POST /admin/leads/:id/notes   Add a note
//
// Userland docs: https://docs.userland.fun/llms.txt

import { demo } from "./demo.js"; // Public demo only. See server/demo.js to remove it.
import { STAGES, createStore, validateLead, validateNote, validateUpdate } from "./leads.js";
import { boardPage, homePage, leadPage, messagePage, newLeadPage, thanksPage } from "./views.js";

const OWNER_ROLE = "owner";
const MAX_FORM_BYTES = 16 * 1024;

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

/** Read a urlencoded or multipart form into a plain object of strings. */
async function readForm(request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_FORM_BYTES) return null;
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) return null;
  const form = await request.formData();
  const values = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") values[name] = value.slice(0, 4000);
  }
  return values;
}

/** Reject form posts sent from other sites. Browsers send Origin on POST. */
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
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

/**
 * createApp() returns the Userland server module. Pass `{ demo }` from
 * server/demo.js to allow demo mode; it then turns on only for requests to
 * the public demo's addresses (DEMO_HOSTS in server/demo.js). Everywhere else
 * the owner routes require a signed-in owner.
 */
export function createApp({ demo = null } = {}) {
  const demoFor = (url) => (demo?.activeFor(url) ? demo : null);

  async function handle(request, ctx) {
    const url = new URL(request.url);
    const demoMode = demoFor(url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isPost = request.method === "POST";
    const isRead = request.method === "GET" || request.method === "HEAD";

    let form = {};
    if (isPost) {
      if (!isSameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
      form = await readForm(request);
      if (!form) return new Response("Unsupported form submission", { status: 400 });
    }
    const rc = requestContext(url, form, demoMode);

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
      const store = openStore(ctx, rc, demoMode);
      const [leads, activity] = await Promise.all([store.listLeads(), store.listActivity({ limit: 8 })]);
      rc.page = "board";
      return html(boardPage(rc, { leads, activity, stage, now: new Date() }));
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

    const match = path.match(/^\/admin\/leads\/([A-Za-z0-9_-]{1,64})(\/stage|\/notes)?$/);
    if (!match) return notFound(rc, "owner");
    const [, leadId, action] = match;

    if (!action && isRead) {
      const store = openStore(ctx, rc, demoMode);
      const lead = await store.getLead(leadId);
      if (!lead) return notFound(rc, "owner");
      const activity = await store.listActivity({ leadId });
      return html(leadPage(rc, { lead, activity, now: new Date(), saved: url.searchParams.get("saved") ?? "" }));
    }

    if (action && isPost) {
      // A visitor's first save in the demo gets a new key, so look the lead up
      // with the store that will do the write.
      const store = openStore(ctx, rc, demoMode, { forWrite: true });
      const lead = await store.getLead(leadId);
      if (!lead) return notFound(rc, "owner");

      if (action === "/stage") {
        const { values, errors } = validateUpdate(form);
        if (Object.keys(errors).length > 0) {
          const activity = await store.listActivity({ leadId });
          return html(leadPage(rc, { lead, activity, now: new Date(), updateErrors: errors }), 422);
        }
        const updated = await store.updateLead(lead, values);
        if (updated.stage !== lead.stage) {
          await ctx.log.info("lead stage changed", { lead_id: lead.id, from: lead.stage, to: updated.stage, demo: rc.demo });
        }
        return redirect(rc.href(`/admin/leads/${encodeURIComponent(lead.id)}?saved=update`));
      }

      const { values, errors } = validateNote(form);
      if (Object.keys(errors).length > 0) {
        const activity = await store.listActivity({ leadId });
        return html(leadPage(rc, { lead, activity, now: new Date(), noteErrors: errors, noteValues: values }), 422);
      }
      await store.addNote(lead, values.body);
      await ctx.log.info("lead note added", { lead_id: lead.id, demo: rc.demo });
      return redirect(rc.href(`/admin/leads/${encodeURIComponent(lead.id)}?saved=note`));
    }

    return new Response("Method not allowed", { status: 405 });
  }

  return {
    async fetch(request, ctx) {
      try {
        return await handle(request, ctx);
      } catch (error) {
        const url = new URL(request.url);
        const rc = requestContext(url, {}, demoFor(url));
        // Only server/demo.js throws this, when a demo visitor (or the demo as
        // a whole) has saved as much as it allows.
        if (error?.code === "demo_limit") {
          const page =
            error.scope === "everyone"
              ? { title: "The demo is full for now", message: "This demo has taken all the new entries it can for now. You can still look around the lead board and the sample leads.", action: { href: rc.href("/admin"), label: "Open the lead board" } }
              : { title: "That's plenty for a demo", message: "This demo has saved as many entries as it can for you. Start fresh from the home page to keep exploring.", action: { href: "/", label: "Start fresh" } };
          return html(messagePage(rc, page), 429);
        }
        await ctx.log.error("request failed", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
        return html(messagePage(rc, { title: "Something went wrong", message: "We couldn't finish that. Please try again in a minute." }), 500);
      }
    }
  };
}

export default createApp({ demo });

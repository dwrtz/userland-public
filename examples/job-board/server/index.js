// Loamwork job board: server routes.
//
// Public pages
//   GET  /                     Job board with search and filters (?q=, ?category=, ?type=)
//   GET  /jobs/:id             One job, with how to apply
//   GET  /post                 "Post a job" form for employers
//   POST /post                 Save a listing as "waiting for review"
//   GET  /post/thanks          Confirmation
//
// Owner pages (app users with the "owner" role)
//   GET  /owner                Review queue and all listings (?tab=pending|approved|rejected|closed|all, ?after= for the next page)
//   GET  /owner/jobs/:id       Edit a listing
//   POST /owner/jobs/:id       Save edits
//   POST /owner/jobs/:id/status  Approve, decline, mark as filled, or put back live
//   GET  /owner/jobs/:id/delete  "Delete this listing?" page
//   POST /owner/jobs/:id/delete  Delete a listing for good
//   GET  /owner/declined/delete  "Delete declined listings?" page
//   POST /owner/declined/delete  Delete declined listings, BULK_DELETE_MAX per press
//
// Sign-in pages come from Userland at /_userland/auth/login and /_userland/auth/logout.

import { CATEGORIES, JOB_TYPES, MAX_PENDING_PER_EMAIL, STATUS_LABELS, listingStore, publicListing, statusPatch, validateListing, withHistory } from "./listings.js";
import { html, messagePage, OWNER_TABS, confirmDeletePage, ownerEditPage, ownerPage, jobPage, boardPage, postPage, thanksPage } from "./views.js";
import { demoMode } from "./demo.js"; // DEMO: delete this line to remove the public demo (see demo.js).

const MAX_FORM_BYTES = 32 * 1024;
const BOARD_PAGE_SIZE = 25;
const OWNER_PAGE_SIZE = 50;

/**
 * Forms must be posted from this app's own pages. Userland's sign-in cookie is
 * SameSite=Lax, and every app on apps.userland.fun counts as the same "site",
 * so without this check a page on another app could submit a hidden form that
 * approves, edits, or deletes listings while the owner is signed in. Browsers
 * always send an Origin header on form posts (sandboxed pages send "null", which
 * is refused); requests without one (curl, tests) pass.
 */
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}

function redirect(location, status = 303) {
  return new Response(null, { status, headers: { location, "cache-control": "no-store" } });
}

async function readForm(request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_FORM_BYTES) return null;
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) return null;
  const form = await request.formData();
  const values = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") values[key] = value.slice(0, 8000);
  }
  return values;
}

/**
 * Build the per-request `site` helper: `link()` makes internal URLs, and on the
 * public demo it keeps the visitor's key in every link and form.
 */
function makeSite(demoUi, visitor) {
  return {
    demo: demoUi,
    visitor,
    link(path, params = {}) {
      const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== ""));
      if (visitor) search.set("demo", visitor);
      const query = search.toString();
      return query ? `${path}?${query}` : path;
    },
    hiddenFields() {
      return visitor ? html`<input type="hidden" name="demo" value="${visitor}">` : "";
    }
  };
}

/**
 * The owner gate. Only signed-in app users with the "owner" role get through.
 * We use ctx.auth.currentUser() instead of requireRole() so we can send people
 * to the sign-in page (or show a clear message) instead of an error.
 */
async function ownerAccess(request, ctx, url, site) {
  const user = await ctx.auth.currentUser(request);
  if (!user) {
    if (request.method === "GET") {
      return { response: redirect(`/_userland/auth/login?return_to=${encodeURIComponent(url.pathname + url.search)}`) };
    }
    return {
      response: messagePage(site, {
        title: "Please sign in",
        message: "Only the board's owner can make changes. Sign in and try again.",
        status: 401,
        action: html`<p><a class="button" href="/_userland/auth/login?return_to=/owner">Sign in</a></p>`
      })
    };
  }
  if (!user.roles.includes("owner")) {
    return {
      response: messagePage(site, {
        title: "This account can't manage listings",
        message: `You're signed in as ${user.email}, which doesn't have owner access to this board.`,
        status: 403,
        action: html`<p><a class="button button-quiet" href="/_userland/auth/logout?return_to=/">Sign out</a></p>`
      })
    };
  }
  return { user };
}

// The data service's page cursor, passed through the owner page's "Show more"
// link. Anything that doesn't look like one is ignored (first page).
function readCursor(url) {
  const value = url.searchParams.get("after") ?? "";
  return value.length <= 64 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value) ? value : "";
}

function readPageNumber(url) {
  const value = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : 1;
}

// A data error with this code means the plan's saved-row allowance is used up.
function isQuotaError(error) {
  return error?.code === "quota_exceeded";
}

function readFilters(url) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const category = url.searchParams.get("category") ?? "";
  const type = url.searchParams.get("type") ?? "";
  return {
    q,
    category: CATEGORIES.some((item) => item.id === category) ? category : "",
    type: JOB_TYPES.some((item) => item.id === type) ? type : ""
  };
}

function matchesFilters(job, filters) {
  if (filters.category && job.category !== filters.category) return false;
  if (filters.type && job.job_type !== filters.type) return false;
  if (filters.q) {
    const haystack = `${job.title} ${job.employer} ${job.location} ${job.summary}`.toLowerCase();
    return filters.q
      .toLowerCase()
      .split(/\s+/u)
      .every((word) => haystack.includes(word));
  }
  return true;
}

// Featured jobs first, then newest first.
function byFeaturedThenNewest(a, b) {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  return b.published_at.localeCompare(a.published_at);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function showBoard(store, site, url) {
  const filters = readFilters(url);
  const { jobs: live, complete } = await store.listLive();
  const allLive = live.map(publicListing).sort(byFeaturedThenNewest);
  const matching = allLive.filter((job) => matchesFilters(job, filters));
  const pageCount = Math.max(1, Math.ceil(matching.length / BOARD_PAGE_SIZE));
  const pageNumber = Math.min(readPageNumber(url), pageCount);
  const jobs = matching.slice((pageNumber - 1) * BOARD_PAGE_SIZE, pageNumber * BOARD_PAGE_SIZE);
  return boardPage(site, { jobs, matchCount: matching.length, allLive, complete, filters, pageNumber, pageCount });
}

async function showJob(store, site, id) {
  const job = await store.get(id);
  if (!job || job.status !== "approved") {
    return messagePage(site, { title: "This job isn't available", message: "It may have been filled or taken down. Take a look at the other open jobs.", status: 404 });
  }
  // Related jobs only need a few, so one page of live jobs is plenty.
  const related = (await store.listLive({ maxRows: 100 })).jobs
    .filter((item) => item.id !== job.id && item.category === job.category)
    .slice(0, 3)
    .map(publicListing);
  return jobPage(site, { job: publicListing(job), related });
}

async function submitListing(request, ctx, store, site) {
  const form = await readForm(request);
  if (!form) return messagePage(site, { title: "That didn't go through", message: "The form was too large or incomplete. Please go back and try again.", status: 400 });

  // Honeypot: people never see the "website" field, but form-filling bots do.
  // Pretend it worked so the bot moves on, and save nothing.
  if (form.website) return redirect(site.link("/post/thanks"));

  const { values, errors } = validateListing(form);
  if (Object.keys(errors).length > 0) {
    return postPage(site, { values, errors, status: 422 });
  }
  let listing;
  try {
    listing = await store.create(values);
  } catch (error) {
    if (error?.name === "SubmissionLimitError") {
      await ctx.log.info("listing refused", { reason: error.reason, demo: Boolean(site.visitor) });
      return error.reason === "email"
        ? messagePage(site, {
            title: "You already have listings waiting",
            message: `We're still reviewing the ${MAX_PENDING_PER_EMAIL} listings sent from this email address. Once we've looked at them, you can send more.`,
            status: 429
          })
        : messagePage(site, {
            title: "New listings are paused for now",
            message: "We have a lot of listings waiting for review. Please try again in a few days.",
            status: 503
          });
    }
    throw error;
  }
  await ctx.log.info("listing submitted", { listing_id: listing.id, category: listing.category, demo: Boolean(site.visitor) });
  return redirect(site.link("/post/thanks"));
}

async function showOwner(store, site, url, user, notice) {
  const { counts, recent } = await store.summary();
  const requested = url.searchParams.get("tab") ?? "";
  const tab = OWNER_TABS.some((item) => item.id === requested) ? requested : counts.pending.count > 0 ? "pending" : "all";
  const after = readCursor(url);
  const { jobs, cursor } = await store.listByStatus(tab === "all" ? null : tab, { cursor: after, limit: OWNER_PAGE_SIZE });
  const done = url.searchParams.get("done") ?? "";
  const doneId = url.searchParams.get("id") ?? "";
  let doneJob = null;
  if (doneId) doneJob = jobs.find((job) => job.id === doneId) ?? recent.find((job) => job.id === doneId) ?? (await store.get(doneId));
  return ownerPage(site, {
    jobs,
    counts,
    recent,
    tab,
    after,
    nextCursor: cursor,
    done,
    doneJob,
    doneCount: Number.parseInt(url.searchParams.get("count") ?? "0", 10) || 0,
    doneMore: url.searchParams.get("more") === "1",
    user,
    notice
  });
}

async function changeStatus(request, ctx, store, site, url, id) {
  const form = await readForm(request);
  const status = form?.status ?? "";
  if (!Object.hasOwn(STATUS_LABELS, status)) return messagePage(site, { title: "Unknown action", message: "Please go back and try again.", status: 400 });
  const job = await store.get(id);
  if (!job) return messagePage(site, { title: "Listing not found", message: "It may have been removed.", status: 404 });
  await store.update(id, statusPatch(job, status));
  await ctx.log.info(`listing ${status}`, { listing_id: id, from: job.status, demo: Boolean(site.visitor) });
  const tab = url.searchParams.get("tab") || job.status;
  return redirect(site.link("/owner", { tab, done: status, id }));
}

async function saveEdits(request, ctx, store, site, id, notice) {
  const job = await store.get(id);
  if (!job) return messagePage(site, { title: "Listing not found", message: "It may have been removed.", status: 404 });
  const form = await readForm(request);
  if (!form) return messagePage(site, { title: "That didn't go through", message: "Please go back and try again.", status: 400 });
  const { values, errors } = validateListing(form, { owner: true });
  if (Object.keys(errors).length > 0) {
    return ownerEditPage(site, { job, values, errors, status: 422, notice });
  }
  await store.update(id, { ...values, history: withHistory(job, "edited") });
  await ctx.log.info("listing edited", { listing_id: id, demo: Boolean(site.visitor) });
  return redirect(site.link("/owner", { tab: job.status, done: "saved", id }));
}

async function deleteListing(ctx, store, site, id) {
  const job = await store.get(id);
  if (!job) return messagePage(site, { title: "Listing not found", message: "It may have been removed already.", status: 404 });
  await store.delete(id);
  await ctx.log.info("listing deleted", { listing_id: id, status: job.status, demo: Boolean(site.visitor) });
  return redirect(site.link("/owner", { tab: job.status, done: "deleted" }));
}

async function deleteDeclined(ctx, store, site) {
  const { deleted, more } = await store.deleteDeclined();
  await ctx.log.info("declined listings deleted", { count: deleted, more, demo: Boolean(site.visitor) });
  return redirect(site.link("/owner", { tab: "rejected", done: "cleared", count: String(deleted), more: more ? "1" : undefined }));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

// HEAD asks for a page's status and headers without the page itself (link
// checkers and uptime monitors send it). Answer it exactly as GET would, then
// drop the body.
async function answerHead(request, ctx, fetchGet) {
  const response = await fetchGet(new Request(request, { method: "GET" }), ctx);
  await response.body?.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * createApp() returns the Userland server module. Pass `{ demo: demoMode }`
 * to allow the public demo on its demo hostname; without it, every owner page
 * requires an owner sign-in.
 */
export function createApp({ demo = null } = {}) {
  const app = {
    async fetch(request, ctx) {
      if (request.method === "HEAD") return await answerHead(request, ctx, app.fetch);
      const url = new URL(request.url);
      const method = request.method;
      const parts = url.pathname.split("/").filter(Boolean);

      if (method === "POST" && !isSameOrigin(request, url)) {
        return new Response("This form has to be sent from the board's own pages.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      const demoOn = Boolean(demo?.activeFor(url));
      let visitor = demoOn ? demo.visitorFrom(url) : null;
      // On the demo, the first change a visitor makes gives them a private key.
      if (demoOn && !visitor && method === "POST") visitor = demo.newVisitor();
      const site = makeSite(demoOn ? demo.ui : null, visitor);
      const store = demoOn ? demo.store(ctx, visitor) : listingStore(ctx);

      // Route the request. Returns null when no route matches.
      const route = async () => {
        // Public pages
        if (parts.length === 0 && method === "GET") return await showBoard(store, site, url);
        if (parts[0] === "jobs" && parts.length === 2 && method === "GET") return await showJob(store, site, parts[1]);
        if (parts[0] === "post" && parts.length === 1 && method === "GET") return postPage(site, {});
        if (parts[0] === "post" && parts.length === 1 && method === "POST") return await submitListing(request, ctx, store, site);
        if (parts[0] === "post" && parts[1] === "thanks" && parts.length === 2 && method === "GET") {
          return thanksPage(site, { demoNext: demoOn && visitor ? demo.ui.thanksNext(site.link) : null });
        }

        // Owner pages
        if (parts[0] === "owner") {
          let user = null;
          if (!demoOn) {
            const access = await ownerAccess(request, ctx, url, site);
            if (access.response) return access.response;
            user = access.user;
          }
          const notice = demoOn ? demo.ui.ownerNotice : "";
          if (parts.length === 1 && method === "GET") return await showOwner(store, site, url, user, notice);
          if (parts[1] === "jobs" && parts.length === 3) {
            const id = parts[2];
            if (method === "GET") {
              const job = await store.get(id);
              if (!job) return messagePage(site, { title: "Listing not found", message: "It may have been removed.", status: 404 });
              return ownerEditPage(site, { job, values: job, notice });
            }
            if (method === "POST") return await saveEdits(request, ctx, store, site, id, notice);
          }
          if (parts[1] === "jobs" && parts[3] === "status" && parts.length === 4 && method === "POST") {
            return await changeStatus(request, ctx, store, site, url, parts[2]);
          }
          if (parts[1] === "jobs" && parts[3] === "delete" && parts.length === 4) {
            if (method === "GET") {
              const job = await store.get(parts[2]);
              if (!job) return messagePage(site, { title: "Listing not found", message: "It may have been removed already.", status: 404 });
              return confirmDeletePage(site, { job, notice });
            }
            if (method === "POST") return await deleteListing(ctx, store, site, parts[2]);
          }
          if (parts[1] === "declined" && parts[2] === "delete" && parts.length === 3) {
            if (method === "GET") {
              const { counts } = await store.summary();
              return confirmDeletePage(site, { declined: counts.rejected, notice });
            }
            if (method === "POST") return await deleteDeclined(ctx, store, site);
          }
        }
        return null;
      };

      try {
        let response;
        try {
          response = await route();
        } catch (error) {
          // Page loads (GET) only read data, so they are safe to repeat: one retry
          // smooths over a brief hiccup reaching the data service. Form posts are
          // never repeated, so a listing can't be saved twice.
          if (method !== "GET" || error?.name === "DemoLimitError") throw error;
          await ctx.log.info("retrying page load", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
          response = await route();
        }
        if (response) return response;
      } catch (error) {
        if (demo && (error?.name === "DemoLimitError" || (demoOn && isQuotaError(error)))) {
          return messagePage(site, { ...demo.ui.limitPage(error), status: 429 });
        }
        if (isQuotaError(error)) {
          // The plan's saved-row allowance is used up. Posting and new changes
          // fail until the owner deletes old listings or upgrades.
          await ctx.log.error("data quota reached", { path: url.pathname });
          return parts[0] === "owner"
            ? messagePage(site, {
                title: "The board is out of room",
                message: "This board has saved as many listings as its plan allows. Delete declined or closed listings to make room, or move to a bigger plan.",
                status: 503
              })
            : messagePage(site, { title: "New listings are paused for now", message: "The board can't take new listings at the moment. Please try again in a few days.", status: 503 });
        }
        await ctx.log.error("request failed", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
        return messagePage(site, { title: "Something went wrong", message: "Please try again in a moment.", status: 500 });
      }

      return messagePage(site, { title: "Page not found", message: "We couldn't find that page.", status: 404 });
    }
  };
  return app;
}

export default createApp({ demo: demoMode }); // DEMO: change to `export default createApp();` when you delete demo.js.

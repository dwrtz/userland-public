// DEMO MODE
//
// This file only exists for the public demo at https://job-board-demo.apps.userland.fun/.
// It lets anyone try the owner side without signing in, while keeping what one
// visitor types away from everyone else:
//
// - The board shows sample listings that live in this file, not in your data.
// - Each visitor gets a random key the first time they post a job or make an
//   owner change. The key rides along in the page links (?demo=...), because
//   Userland only passes its own sign-in cookie through to server code.
// - Listings a visitor creates, and any change they make to a sample listing,
//   are saved in the `demo-listings` collection under that key. Nobody without
//   the key can see them. They stop showing a day later (see expires_at) and are
//   deleted the next time anyone uses the demo.
// - Each key can save up to MAX_ROWS_PER_VISITOR rows. The whole demo keeps
//   about MAX_ACTIVE_ROWS unexpired rows: once it's full, each new save removes
//   the oldest demo rows instead of turning visitors away, so a script that
//   skips the key can't fill the demo's storage or lock anyone out. It only
//   makes older demo changes disappear sooner. (See saveRow() below.)
// - Demo pages carry a noindex tag and a "Built with Userland" note.
//
// Demo mode only switches on for the hostnames in DEMO_HOSTS, so a copy of this
// app published anywhere else runs the real, signed-in owner pages.
//
// To remove the demo from your own board:
// 1. Delete this file.
// 2. In server/index.js, delete the `import { demoMode } ...` line and change
//    the last line to `export default createApp();`.
// 3. Delete the `demo-listings` collection from manifest.userland.json.
// 4. Delete tests/demo.test.ts.

import { html } from "./views.js";
import { toListing, withHistory } from "./listings.js";

// The public demo's named address and the demo app's own address. Both belong
// to the Userland demo deployment only, so every page of it is marked noindex;
// replace them if you publish your own demo.
const DEMO_HOSTS = new Set(["job-board-demo.apps.userland.fun", "4fz14jppml2y13cxqx1.apps.userland.fun"]);
const EXAMPLE_PAGE = "https://userland.fun/examples/job-board/";
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const MAX_ROWS_PER_VISITOR = 30;
const MAX_ACTIVE_ROWS = 200;
// Once the demo is full, each save removes up to this many of the oldest rows.
const EVICT_PER_SAVE = 2;
// When many saves at once push the demo further over, each save takes back up
// to this many of the newest extra rows.
const TRIM_PER_SAVE = 5;
// "Delete declined listings" in the demo handles this many per press.
const DEMO_BULK_DELETE_MAX = 10;
const KEEP_FOR_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

class DemoLimitError extends Error {
  name = "DemoLimitError";
  constructor(reason) {
    super(reason === "busy" ? "Demo is busy." : "Demo limit reached.");
    this.reason = reason;
  }
}

function newVisitorKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

// ---------------------------------------------------------------------------
// Sample listings. Fictional farms; every address is at example.com.
// `days` is how long ago the listing was posted.
// ---------------------------------------------------------------------------

const SAMPLES = [
  {
    id: "market-garden-crew",
    days: 1,
    status: "approved",
    featured: true,
    title: "Market garden crew member",
    employer: "Stonebank Market Garden",
    location: "Mount Vernon, WA",
    category: "field-crops",
    job_type: "seasonal",
    pay: "$20–22/hr",
    summary: "Seed, weed, harvest, and wash-pack on a two-acre no-till garden that feeds 180 CSA members.",
    description:
      "We grow forty kinds of vegetables on permanent beds and never till. You'll join a crew of four from April through October, working a mix of field days and wash-pack days.\n\nNo farm experience needed if you're comfortable lifting 40 pounds and working in the rain. We teach everything else, from transplanting to running the walk-in cooler.\n\nFour ten-hour days a week, with Fridays off.",
    apply_link: "stonebank@example.com",
    contact_name: "June Adler",
    contact_email: "june.adler@example.com"
  },
  {
    id: "orchard-crew-lead",
    days: 3,
    status: "approved",
    featured: false,
    title: "Orchard crew lead",
    employer: "Heron Hill Orchard",
    location: "Hood River, OR",
    category: "orchards",
    job_type: "full-time",
    pay: "$58,000–64,000/yr + housing",
    summary: "Lead a crew of six through pruning, thinning, and harvest on 40 acres of organic pears and apples.",
    description:
      "Heron Hill has grown organic pears on the east side of the valley since 1994. We're looking for a crew lead who can plan the week's work, train new hands, and keep everyone safe on ladders.\n\nYou'll need two seasons of orchard experience and a driver's license. Spanish is a big plus.\n\nThe job comes with a two-bedroom house on the farm, health insurance, and a share of the fruit.",
    apply_link: "https://example.com/heron-hill/jobs",
    contact_name: "Marcus Bell",
    contact_email: "marcus.bell@example.com"
  },
  {
    id: "grazing-apprentice",
    days: 5,
    status: "approved",
    featured: false,
    title: "Grazing apprentice",
    employer: "Blue Camas Ranch",
    location: "Ellensburg, WA",
    category: "livestock",
    job_type: "apprenticeship",
    pay: "$2,400/mo + room and board",
    summary: "Learn rotational grazing with 120 cow-calf pairs, moving fence daily across 900 acres of rangeland.",
    description:
      "Our apprenticeship runs March to November. You'll move cattle and polywire every day, monitor pasture recovery, check water, and help with calving and weaning.\n\nEach week includes a planning session where we walk through the grazing chart together. By the end of the season you'll be able to plan a rotation yourself.\n\nHousing is a private cabin with a shared kitchen.",
    apply_link: "bluecamas@example.com",
    contact_name: "Ruth Okafor",
    contact_email: "ruth.okafor@example.com"
  },
  {
    id: "csa-delivery-driver",
    days: 6,
    status: "approved",
    featured: false,
    title: "CSA packing and delivery driver",
    employer: "Two Creeks Farm Share",
    location: "Olympia, WA",
    category: "markets",
    job_type: "part-time",
    pay: "$21/hr",
    summary: "Pack weekly vegetable shares on Tuesdays and drive the delivery route to six pickup sites on Wednesdays.",
    description:
      "Two Creeks is a farm share that pools produce from five small farms. We need a steady, friendly person to pack about 250 shares a week and run our delivery van.\n\nYou'll need a clean driving record and be able to lift 50 pounds. Hours are about 16 a week from June through November.",
    apply_link: "twocreeks@example.com",
    contact_name: "Dee Harmon",
    contact_email: "dee.harmon@example.com"
  },
  {
    id: "farm-school-educator",
    days: 8,
    status: "approved",
    featured: false,
    title: "Farm school educator",
    employer: "Mudroom Farm School",
    location: "Corvallis, OR",
    category: "education",
    job_type: "full-time",
    pay: "$24–27/hr",
    summary: "Teach hands-on garden and animal classes to K–8 school groups on a working teaching farm.",
    description:
      "Every week about 300 kids visit Mudroom to plant, harvest, cook, and meet our goats and chickens. We're hiring an educator to lead field trips and our summer farm camp.\n\nYou'll plan lessons with our education lead and teach groups of up to 15. Teaching experience with kids is required; farm experience is a bonus.\n\nFull benefits, including paid time off between seasons.",
    apply_link: "https://example.com/mudroom/careers",
    contact_name: "Tomas Reyes",
    contact_email: "tomas.reyes@example.com"
  },
  {
    id: "vineyard-season-hand",
    days: 9,
    status: "approved",
    featured: false,
    title: "Vineyard season hand",
    employer: "Sorrel Ridge Vineyard",
    location: "Walla Walla, WA",
    category: "orchards",
    job_type: "seasonal",
    pay: "$20/hr",
    summary: "Canopy work, cover-crop mowing, and harvest on a dry-farmed vineyard. Late May through October.",
    description:
      "We farm 22 acres of grapes without irrigation and graze sheep between the rows in winter. Season hands help with shoot thinning, leaf pulling, netting, and harvest.\n\nMornings start early in the summer heat, and we finish by 2 p.m. Harvest weeks can run long.",
    apply_link: "sorrelridge@example.com",
    contact_name: "Ana Lindqvist",
    contact_email: "ana.lindqvist@example.com"
  },
  {
    id: "market-manager",
    days: 12,
    status: "approved",
    featured: false,
    title: "Saturday market manager",
    employer: "Riverside Growers Market",
    location: "Eugene, OR",
    category: "markets",
    job_type: "part-time",
    pay: "$25/hr",
    summary: "Run setup, vendor check-in, and the info booth at a 60-vendor Saturday farmers market.",
    description:
      "Riverside Growers Market runs every Saturday from April through November. The manager arrives at 6 a.m., places vendors, handles the token booth, and keeps the day running smoothly.\n\nAbout 12 hours a week, plus a monthly vendor meeting.",
    apply_link: "https://example.com/riverside-market/jobs",
    contact_name: "Priya Natarajan",
    contact_email: "priya.natarajan@example.com"
  },
  {
    id: "assistant-farm-manager",
    days: 15,
    status: "approved",
    featured: false,
    title: "Assistant farm manager",
    employer: "Little Fern Dairy",
    location: "Tillamook, OR",
    category: "management",
    job_type: "full-time",
    pay: "$55,000/yr + housing",
    summary: "Help run a 70-cow grass-fed dairy: milking schedules, pasture plans, and a crew of five.",
    description:
      "Little Fern is a family dairy that ships to a small creamery down the road. We're looking for someone ready to step into management: scheduling milking shifts, keeping herd records, and planning grazing with the owners.\n\nYou'll need at least three years on a dairy. Housing is a farmhouse apartment.",
    apply_link: "littlefern@example.com",
    contact_name: "Sam Whitaker",
    contact_email: "sam.whitaker@example.com"
  },
  {
    id: "seed-saving-apprentice",
    days: 20,
    status: "approved",
    featured: false,
    title: "Seed saving apprentice",
    employer: "Cedar & Clover Seed Co.",
    location: "Bellingham, WA",
    category: "field-crops",
    job_type: "apprenticeship",
    pay: "$18/hr",
    summary: "Grow, harvest, and clean open-pollinated seed crops for a small regional seed company.",
    description:
      "Learn the whole seed cycle: planting isolation plots, rogueing off-types, harvesting, threshing, and germination testing.\n\nThe apprenticeship runs May through October, about 30 hours a week.",
    apply_link: "cedarclover@example.com",
    contact_name: "Hana Mori",
    contact_email: "hana.mori@example.com"
  },
  {
    id: "egg-crew",
    days: 1,
    status: "pending",
    featured: false,
    title: "Pasture poultry crew",
    employer: "Mossy Gate Farm",
    location: "Chehalis, WA",
    category: "livestock",
    job_type: "part-time",
    pay: "$19/hr",
    summary: "Move mobile coops, collect and wash eggs, and help with weekly processing days.",
    description:
      "We keep 1,200 laying hens on pasture in mobile coops. The crew moves coops every morning, collects and washes eggs, and packs orders for three grocery stores.\n\nMornings only, five days a week.",
    apply_link: "mossygate@example.com",
    contact_name: "Lee Carver",
    contact_email: "lee.carver@example.com"
  },
  {
    id: "youth-garden-coordinator",
    days: 2,
    status: "pending",
    featured: false,
    title: "Youth garden coordinator",
    employer: "Northgate Community Garden",
    location: "Spokane, WA",
    category: "education",
    job_type: "seasonal",
    pay: "$22/hr",
    summary: "Run a summer garden program for teens: planting, harvest, and a weekly farm stand.",
    description:
      "Our summer program pays twelve teens to grow food for their neighborhood. The coordinator plans the season, supervises the crew, and runs a Saturday farm stand with them.\n\nJune through August, 32 hours a week.",
    apply_link: "northgate@example.com",
    contact_name: "Rosa Delgado",
    contact_email: "rosa.delgado@example.com"
  },
  {
    id: "work-from-home",
    days: 4,
    status: "rejected",
    featured: false,
    title: "Earn $5,000 a week from home!!!",
    employer: "Quick Start Opportunities",
    location: "Anywhere",
    category: "management",
    job_type: "part-time",
    pay: "",
    summary: "No experience needed. Send a small starter fee to begin earning right away.",
    description: "This is an example of a listing the owner declined. It asks applicants to pay a fee and has nothing to do with farming.",
    apply_link: "https://example.com/quick-start",
    contact_name: "Unknown",
    contact_email: "offers@example.com"
  }
];

/** The sample listings, with dates worked out relative to `now`. */
export function sampleListings(now = Date.now()) {
  return SAMPLES.map(({ days, ...sample }) => {
    const submitted = new Date(now - days * DAY_MS - 3 * 60 * 60 * 1000).toISOString();
    const published = sample.status === "approved" ? new Date(now - days * DAY_MS).toISOString() : "";
    const history = [{ at: submitted, action: "submitted" }];
    if (sample.status !== "pending") history.push({ at: published || new Date(now - days * DAY_MS).toISOString(), action: sample.status });
    return { ...sample, owner_note: "", history, submitted_at: submitted, published_at: published };
  });
}

// ---------------------------------------------------------------------------
// The demo store: same shape as listingStore() in listings.js.
// ---------------------------------------------------------------------------

function demoStore(ctx, visitor) {
  const rows = ctx.data.collection("demo-listings");
  let own = null; // this visitor's unexpired rows, read once per request
  let swept = false;

  async function mine() {
    if (!visitor) return [];
    if (!own) {
      const now = new Date().toISOString();
      const page = await rows.list({
        where: { visitor },
        order_by: [{ field: "submitted_at", direction: "desc" }],
        limit: 100
      });
      own = page.rows.filter((row) => !row.expires_at || row.expires_at > now);
    }
    return own;
  }

  // Clean up expired rows once per request, on page views as well as changes,
  // so what visitors typed doesn't linger on a quiet demo. A failed cleanup
  // never breaks the page.
  async function sweep() {
    if (swept) return;
    swept = true;
    try {
      await deleteExpired(rows);
    } catch (error) {
      await ctx.log.info("demo cleanup skipped", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Samples (with this visitor's changes applied) plus the visitor's own listings.
  async function everything() {
    await sweep();
    const saved = await mine();
    const changed = new Map(saved.filter((row) => row.source_id).map((row) => [row.source_id, row]));
    const samples = sampleListings().map((sample) => (changed.has(sample.id) ? { ...toListing(changed.get(sample.id)), id: sample.id } : sample));
    const created = saved.filter((row) => !row.source_id).map(toListing);
    // A sample the visitor deleted is kept as a copy marked "deleted" and hidden.
    return [...created, ...samples].filter((listing) => listing.status !== "deleted");
  }

  function requireVisitor() {
    if (!visitor) throw new Error("Demo changes need a visitor key.");
  }

  // Save a new row for this visitor, keeping the demo near MAX_ACTIVE_ROWS.
  async function saveRow(fields) {
    const saved = await mine();
    if (saved.length >= MAX_ROWS_PER_VISITOR) throw new DemoLimitError("visitor");
    await sweep();
    let row;
    try {
      row = await rows.create({ ...fields, visitor, expires_at: expiresAt() });
    } catch (error) {
      // The demo app's own row allowance is used up: free a little room for the
      // next try, then show the busy page.
      if (error?.code === "quota_exceeded") await deleteOldest(rows, EVICT_PER_SAVE).catch(() => undefined);
      throw error;
    }
    own = [row, ...saved];
    await keepUnderCap(row);
    return row;
  }

  // After a save, look at the unexpired rows, newest first. A few over the cap
  // (the normal case once the demo is full): delete the oldest ones. Many over
  // (lots of saves at the same moment, like a script firing requests in
  // parallel): delete up to TRIM_PER_SAVE of the newest extras, this save
  // first if it's one of them, and show the busy page. Every save that finds
  // the demo far over the cap trims a few more, so it gets back under the cap
  // however the saves overlapped, instead of staying stuck on the busy page.
  async function keepUnderCap(row) {
    const active = await newestActive(rows);
    const takeBack = () => {
      own = own?.filter((item) => item.id !== row.id) ?? null;
      return new DemoLimitError("busy");
    };
    // Another save at the same moment already took this one back out.
    if (!active.some((item) => item.id === row.id)) throw takeBack();
    const over = active.length - MAX_ACTIVE_ROWS;
    if (over <= 0) return;
    if (over > EVICT_PER_SAVE) {
      const extras = active.slice(0, over);
      const isExtra = extras.some((item) => item.id === row.id);
      const trim = [...(isExtra ? [row] : []), ...extras.filter((item) => item.id !== row.id)].slice(0, TRIM_PER_SAVE);
      for (const item of trim) await rows.delete(item.id);
      if (isExtra) throw takeBack();
      return;
    }
    for (const old of active.slice(-over)) {
      if (old.id !== row.id) await rows.delete(old.id);
    }
  }

  async function saveCopyOfSample(id, patch) {
    const sample = sampleListings().find((item) => item.id === id);
    if (!sample) throw new Error("Listing not found.");
    // First change to a sample listing: save a private copy for this visitor.
    const { id: _sampleId, ...fields } = sample;
    return await saveRow({ ...fields, ...patch, source_id: id });
  }

  // Delete one listing from this visitor's copy of the board. `saved` is the
  // visitor's rows, already read.
  async function deleteOne(saved, id) {
    const created = saved.find((row) => row.id === id && !row.source_id);
    if (created) {
      await rows.delete(id);
      own = own?.filter((row) => row.id !== id) ?? null;
      return;
    }
    const change = saved.find((row) => row.source_id === id);
    if (change) {
      await rows.update(change.id, { status: "deleted" });
      return;
    }
    await saveCopyOfSample(id, { status: "deleted" });
  }

  const store = {
    async listLive({ category = "", type = "" } = {}) {
      const listings = await everything();
      const live = listings.filter((listing) => listing.status === "approved" && (!category || listing.category === category) && (!type || listing.job_type === type));
      return { jobs: live.sort((a, b) => b.published_at.localeCompare(a.published_at)), cursor: "" };
    },
    // A visitor has at most a few dozen listings, so everything fits on one page.
    async listByStatus(status) {
      const listings = await everything();
      return { jobs: listings.filter((listing) => !status || listing.status === status).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)), cursor: "" };
    },
    async get(id) {
      const listings = await everything();
      return listings.find((listing) => listing.id === id) ?? null;
    },
    async create(values) {
      requireVisitor();
      const now = new Date().toISOString();
      const row = await saveRow({
        ...values,
        source_id: "",
        status: "pending",
        featured: false,
        owner_note: "",
        history: withHistory(null, "submitted", now),
        submitted_at: now
      });
      return toListing(row);
    },
    async update(id, patch) {
      requireVisitor();
      const saved = await mine();
      const created = saved.find((row) => row.id === id && !row.source_id);
      if (created) return toListing(await rows.update(id, patch));
      const change = saved.find((row) => row.source_id === id);
      if (change) return { ...toListing(await rows.update(change.id, patch)), id };
      return { ...toListing(await saveCopyOfSample(id, patch)), id };
    },
    async delete(id) {
      requireVisitor();
      await deleteOne(await mine(), id);
    },
    // Up to DEMO_BULK_DELETE_MAX per press, with no cleanup sweep, so this
    // request stays under 20 data calls: 1 read, up to 10 deletes, and for the
    // one declined sample listing a saved copy (1 save, then up to 3 reads and
    // TRIM_PER_SAVE deletes in keepUnderCap).
    async deleteDeclined() {
      requireVisitor();
      swept = true;
      const declined = (await everything()).filter((listing) => listing.status === "rejected");
      const batch = declined.slice(0, DEMO_BULK_DELETE_MAX);
      const saved = await mine();
      for (const listing of batch) await deleteOne(saved, listing.id);
      return { deleted: batch.length, more: declined.length > batch.length };
    }
  };
  return store;
}

// Every demo row carries an expires_at date a day after it was saved. Once per
// request, delete up to CLEANUP_DELETES rows whose date has passed. Listing by
// expires_at, oldest first, puts expired rows at the front no matter how many
// visitors arrive in a day, and the cap keeps each request to a handful of
// data calls: 1 list + 5 deletes.
const CLEANUP_DELETES = 5;
// keepUnderCap() reads at most this many unexpired rows (3 list calls).
const SCAN_ROWS = MAX_ACTIVE_ROWS + 100;

function expiresAt(now = Date.now()) {
  return new Date(now + KEEP_FOR_MS).toISOString();
}

async function deleteExpired(rows) {
  const now = new Date().toISOString();
  const page = await rows.list({
    order_by: [{ field: "expires_at", direction: "asc" }],
    limit: CLEANUP_DELETES
  });
  for (const row of page.rows) {
    if (!row.expires_at || row.expires_at > now) break;
    await rows.delete(row.id);
  }
}

// Delete the `count` demo rows that expire first, expired or not.
async function deleteOldest(rows, count) {
  const page = await rows.list({ order_by: [{ field: "expires_at", direction: "asc" }], limit: count });
  for (const row of page.rows) await rows.delete(row.id);
}

// Unexpired demo rows, newest expiry first, up to SCAN_ROWS of them. The read
// stops at the first expired row.
async function newestActive(rows) {
  const now = new Date().toISOString();
  const active = [];
  let cursor;
  do {
    const page = await rows.list({
      order_by: [{ field: "expires_at", direction: "desc" }],
      limit: 100,
      ...(cursor ? { cursor } : {})
    });
    for (const row of page.rows) {
      if (!row.expires_at || row.expires_at <= now) return active;
      active.push(row);
    }
    cursor = page.cursor;
  } while (cursor && active.length < SCAN_ROWS);
  return active;
}

// ---------------------------------------------------------------------------
// Demo notices shown on every page. Plain language for visitors.
// ---------------------------------------------------------------------------

const ui = {
  head: html`<meta name="robots" content="noindex,follow">`,
  banner: html`<div class="demo-banner" role="note"><div class="wrap demo-banner-inner"><p><strong>Demo job board.</strong> Post a job, then approve it in the owner view. What you add shows up only for you (and anyone you share your links with), and it's cleared after about a day.</p><a href="${EXAMPLE_PAGE}">See how it's made</a></div></div>`,
  footer: html`<p class="demo-credit">Demo app. Built with Userland. <a href="${EXAMPLE_PAGE}">See how it's made</a></p>`,
  ownerNotice: html`<div class="demo-note" role="note"><p><strong>You're in the owner view.</strong> On a real board, this page asks the owner to sign in first. Here it's open so you can try approving, declining, editing, and deleting listings. Your changes only show up for you.</p></div>`,
  thanksNext: (link) =>
    html`<div class="demo-next"><h2>Now try the owner side</h2><p>Open the review queue, approve your listing, and it will appear on the board for you.</p><a class="button" href="${link("/owner", { tab: "pending" })}">Open the review queue</a></div>`,
  // The page shown when a save hits the per-visitor cap, arrives in a burst of
  // saves over the demo-wide cap, or hits the demo app's own storage limit.
  limitPage: (error) =>
    error?.reason === "busy" || error?.code === "quota_exceeded"
      ? { title: "The demo is busy", message: "Lots of people are trying the demo right now. Please try again in a minute." }
      : { title: "That's a lot of changes", message: `This demo keeps up to ${MAX_ROWS_PER_VISITOR} changes per visit. Open the board in a new private window to start fresh.` }
};

export const demoMode = {
  /** True when this request is for the public demo. */
  activeFor(url) {
    return DEMO_HOSTS.has(url.hostname);
  },
  /** The visitor key from the page link, if it is well formed. */
  visitorFrom(url) {
    const key = url.searchParams.get("demo") ?? "";
    return KEY_PATTERN.test(key) ? key : null;
  },
  newVisitor: newVisitorKey,
  store: demoStore,
  ui
};

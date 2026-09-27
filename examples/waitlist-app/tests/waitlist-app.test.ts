import { readFileSync } from "node:fs";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import app from "../server/index.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { rankWaitlist, toCsv, REFERRAL_BOOST } from "../server/waitlist.js";
// @ts-expect-error Example server files are plain JavaScript app bundles.
import { sampleSignups } from "../server/demo.js";

type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string };
type CollectionSpec = { fields: Record<string, unknown>; indexes?: Array<{ name: string; fields: string[]; unique?: boolean }> };

const manifest = JSON.parse(readFileSync(new URL("../manifest.userland.json", import.meta.url), "utf8"));
const collections: Record<string, CollectionSpec> = manifest.resources.data.collections;

const APP = "https://velto.example.test";
const DEMO = "https://waitlist-demo.apps.userland.fun";

// An in-memory ctx that follows the runtime rules: declared fields only, `where` and
// `order_by` on indexed fields only, unique indexes, and at most 100 rows per list call.
function makeCtx() {
  const tables: Record<string, Row[]> = {};
  let next = 0;
  const failure = (code: string, message: string) => Object.assign(new Error(message), { code, status: 400 });

  function collection(name: string) {
    const spec = collections[name];
    if (!spec) throw failure("missing_collection", `Data collection ${name} is not declared.`);
    const rows = (tables[name] ??= []);
    const indexed = new Set((spec.indexes ?? []).flatMap((index) => index.fields));
    const checkFields = (input: Record<string, unknown>) => {
      for (const key of Object.keys(input)) if (!(key in spec.fields)) throw failure("invalid_resource_manifest", `Field ${key} is not declared.`);
    };
    const checkUnique = (data: Record<string, unknown>, id: string | null) => {
      for (const index of (spec.indexes ?? []).filter((item) => item.unique)) {
        const value = JSON.stringify(index.fields.map((field) => data[field]));
        if (rows.some((row) => row.id !== id && JSON.stringify(index.fields.map((field) => row[field])) === value)) {
          throw failure("unique_conflict", `Unique index ${index.name} already contains this value.`);
        }
      }
    };
    return {
      async create(input: Record<string, unknown>) {
        checkFields(input);
        checkUnique(input, null);
        const now = new Date().toISOString();
        const row: Row = { ...input, id: `row_${++next}`, created_at: now, updated_at: now };
        rows.push(row);
        return { ...row };
      },
      async get(id: string) {
        const row = rows.find((item) => item.id === id);
        return row ? { ...row } : null;
      },
      async update(id: string, patch: Record<string, unknown>) {
        checkFields(patch);
        const index = rows.findIndex((item) => item.id === id);
        if (index === -1) throw failure("not_found", "Data row not found.");
        const updated = { ...rows[index], ...patch, updated_at: new Date().toISOString() } as Row;
        checkUnique(updated, id);
        rows[index] = updated;
        return { ...updated };
      },
      async delete(id: string) {
        const index = rows.findIndex((item) => item.id === id);
        if (index !== -1) rows.splice(index, 1);
      },
      async list(
        query: { where?: Record<string, unknown>; order_by?: Array<{ field: string; direction?: "asc" | "desc" }>; limit?: number; cursor?: string } = {}
      ) {
        for (const field of Object.keys(query.where ?? {})) if (!indexed.has(field)) throw failure("unindexed_query", `Query field ${field} is not indexed.`);
        for (const order of query.order_by ?? []) if (!indexed.has(order.field)) throw failure("unindexed_query", `Order field ${order.field} is not indexed.`);
        if (query.limit !== undefined && (query.limit < 1 || query.limit > 100)) throw failure("invalid_query", "Query limit must be between 1 and 100.");
        const matches = rows.filter((row) => Object.entries(query.where ?? {}).every(([key, value]) => row[key] === value));
        for (const order of [...(query.order_by ?? [])].reverse()) {
          const direction = order.direction === "desc" ? -1 : 1;
          matches.sort((a, b) => String(a[order.field] ?? "").localeCompare(String(b[order.field] ?? "")) * direction);
        }
        const offset = query.cursor ? Number(atob(query.cursor)) : 0;
        const page = matches.slice(offset, offset + (query.limit ?? 50));
        const end = offset + page.length;
        return { rows: page.map((row) => ({ ...row })), ...(end < matches.length ? { cursor: btoa(String(end)) } : {}) };
      }
    };
  }

  type Data = { collection: typeof collection; transaction<T>(callback: (tx: Data) => Promise<T>): Promise<T> };
  const data: Data = { collection, async transaction(callback) { return await callback(data); } };
  const users: Record<string, { id: string; email: string; roles: string[] }> = {
    owner: { id: "user_owner", email: "owner@example.com", roles: ["owner"] },
    helper: { id: "user_helper", email: "helper@example.com", roles: [] }
  };
  const currentUser = async (request: Request) => {
    const session = /__Host-ul_session=(\w+)/u.exec(request.headers.get("cookie") ?? "")?.[1];
    return session ? users[session] ?? null : null;
  };
  return {
    tables,
    data,
    auth: {
      currentUser,
      async requireRole(request: Request, role: string) {
        const user = await currentUser(request);
        if (!user || !user.roles.includes(role)) throw new Error("Required role is missing.");
        return user;
      }
    },
    log: { info: vi.fn(async () => undefined) }
  };
}

type Ctx = ReturnType<typeof makeCtx>;

async function call(ctx: Ctx, url: string, init: RequestInit = {}): Promise<Response> {
  return await app.fetch(new Request(url, init), ctx);
}

function post(ctx: Ctx, url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return call(ctx, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin, ...headers },
    body: new URLSearchParams(fields).toString()
  });
}

async function join(ctx: Ctx, base: string, fields: Record<string, string>) {
  const response = await post(ctx, `${base}/join`, fields);
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(/^\/you\/[^/]+\/[^/]+$/u);
  return location;
}

const owner = { cookie: "__Host-ul_session=owner" };

describe("public visitor", () => {
  it("joins, sees a place in line, and saves optional answers", async () => {
    const ctx = makeCtx();
    const landing = await call(ctx, `${APP}/`);
    expect(landing.status).toBe(200);
    const landingHtml = await landing.text();
    expect(landingHtml).toContain('action="/join"');
    expect(landingHtml).not.toContain('name="robots" content="noindex');

    const statusPath = await join(ctx, APP, { email: "Ada@Example.com ", name: "Ada" });
    const status = await call(ctx, `${APP}${statusPath}`);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const statusHtml = await status.text();
    expect(statusHtml).toContain("You're in, Ada.");
    expect(statusHtml).toContain("#</span>1</p>");
    expect(statusHtml).toContain('<meta name="robots" content="noindex">');
    expect(ctx.log.info).toHaveBeenCalledWith("waitlist signup", expect.objectContaining({ referred: false }));
    expect(ctx.tables.signups[0]).toMatchObject({ email: "ada@example.com", status: "waiting" });

    const saved = await post(ctx, `${APP}${statusPath}/answers`, { frequency: "weekly", goal: "company", city: "Portland" });
    expect(saved.headers.get("location")).toBe(`${statusPath}?saved=1`);
    expect(ctx.tables.signups[0]).toMatchObject({ frequency: "weekly", goal: "company", city: "Portland" });
  });

  it("rejects bad input, duplicates, bots, and wrong private links", async () => {
    const ctx = makeCtx();
    const invalid = await post(ctx, `${APP}/join`, { email: "not-an-email" });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("doesn&#39;t look right");
    for (const email of ['a"><script>alert(1)</script>@evil.io', "(x)@example.com", "x@localhost", "a b@example.com"]) {
      expect((await post(ctx, `${APP}/join`, { email })).status).toBe(400);
    }
    expect(ctx.tables.signups ?? []).toHaveLength(0);

    await join(ctx, APP, { email: "ada@example.com" });
    // A repeat email gets the same neutral answer as a bot, so the form can't
    // be used to check whether someone signed up.
    const duplicate = await post(ctx, `${APP}/join`, { email: "ADA@example.com" });
    expect(duplicate.status).toBe(303);
    expect(duplicate.headers.get("location")).toBe("/thanks");

    const bot = await post(ctx, `${APP}/join`, { email: "bot@example.com", company: "Spam Inc" });
    expect(bot.status).toBe(303);
    expect(bot.headers.get("location")).toBe("/thanks");
    expect(ctx.tables.signups).toHaveLength(1);
    expect(await (await call(ctx, `${APP}/thanks`)).text()).toContain("If you joined before");

    const crossSite = await post(ctx, `${APP}/join`, { email: "x@example.com" }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(400);

    const id = ctx.tables.signups[0].id;
    expect((await call(ctx, `${APP}/you/${id}/wrong-token`)).status).toBe(404);
  });

  it("moves the referrer up the line when a friend joins with their link", async () => {
    const ctx = makeCtx();
    // Give each signup its own join time, one minute apart.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-01T12:00:00Z") });
    const firstPaths = [];
    for (let index = 0; index < 12; index += 1) {
      firstPaths.push(await join(ctx, APP, { email: `runner${index}@example.com` }));
      vi.setSystemTime(Date.now() + 60_000);
    }
    const last = ctx.tables.signups[11];

    const shortLink = await call(ctx, `${APP}/r/${String(last.referral_code).toLowerCase()}`);
    expect(shortLink.headers.get("location")).toBe(`/?ref=${last.referral_code}`);
    expect(await (await call(ctx, `${APP}/?ref=${last.referral_code}`)).text()).toContain("saved you a spot");

    await join(ctx, APP, { email: "friend@example.com", ref: String(last.referral_code) });
    expect(ctx.tables.signups[12]).toMatchObject({ referred_by: last.referral_code, source: "friend" });

    const html = await (await call(ctx, `${APP}${firstPaths[11]}`)).text();
    expect(html).toContain(`#</span>${12 - REFERRAL_BOOST}</p>`);
    expect(html).toContain("<b>1</b> friend has joined");
    vi.useRealTimers();
  });

  it("counts every friend who joins at the same moment, and drops credit for archived ones", async () => {
    const ctx = makeCtx();
    const hostPath = await join(ctx, APP, { email: "host@example.com" });
    const code = String(ctx.tables.signups[0].referral_code);
    // Nothing is read-then-written on the referrer, so simultaneous joins can't lose a credit.
    await Promise.all(["f1", "f2", "f3"].map((name) => join(ctx, APP, { email: `${name}@example.com`, ref: code })));
    expect(await (await call(ctx, `${APP}${hostPath}`)).text()).toContain("<b>3</b> friends have joined");

    const fake = ctx.tables.signups.find((row) => row.email === "f3@example.com");
    await post(ctx, `${APP}/admin/signups/${fake?.id}/status`, { status: "archived" }, owner);
    expect(await (await call(ctx, `${APP}${hostPath}`)).text()).toContain("<b>2</b> friends have joined");
  });

  it("reads one page of signups, not the whole list, for the public landing page", async () => {
    const ctx = makeCtx();
    const signups = ctx.data.collection("signups");
    for (let index = 0; index < 250; index += 1) {
      await signups.create({ email: `r${index}@example.com`, status: "waiting", joined_at: new Date().toISOString(), referral_code: `R${index}` });
    }
    const list = vi.fn(signups.list);
    const collection = ctx.data.collection;
    ctx.data.collection = ((name: string) => ({ ...collection(name), list })) as typeof collection;
    const html = await (await call(ctx, `${APP}/`)).text();
    expect(list).toHaveBeenCalledTimes(1);
    expect(html).toContain("<b>100+</b> runners have already joined.");
  });

  it("escapes what people type", async () => {
    const ctx = makeCtx();
    const statusPath = await join(ctx, APP, { email: "x@example.com", name: "<script>alert(1)</script>" });
    const html = await (await call(ctx, `${APP}${statusPath}`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    const ownerHtml = await (await call(ctx, `${APP}/admin`, { headers: owner })).text();
    expect(ownerHtml).not.toContain("<script>alert");
  });
});

describe("owner view with demo mode off", () => {
  it("sends signed-out visitors to sign in and blocks accounts without the owner role", async () => {
    const ctx = makeCtx();
    await join(ctx, APP, { email: "ada@example.com" });

    const signedOut = await call(ctx, `${APP}/admin?status=waiting`);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin%3Fstatus%3Dwaiting");
    expect((await call(ctx, `${APP}/admin/export.csv`)).status).toBe(303);

    const id = ctx.tables.signups[0].id;
    const blockedChange = await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "invited" });
    expect(blockedChange.status).toBe(303);
    expect(ctx.tables.signups[0].status).toBe("waiting");

    const helper = await call(ctx, `${APP}/admin`, { headers: { cookie: "__Host-ul_session=helper" } });
    expect(helper.status).toBe(403);
    expect(await helper.text()).not.toContain("ada@example.com");
  });

  it("lets the owner filter, change status, and export", async () => {
    const ctx = makeCtx();
    const adaPath = await join(ctx, APP, { email: "ada@example.com", name: "Ada" });
    await post(ctx, `${APP}${adaPath}/answers`, { frequency: "training", goal: "race" });
    await join(ctx, APP, { email: "=cmd@example.com", name: "@SUM(A1)" });

    const page = await call(ctx, `${APP}/admin`, { headers: owner });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("demo-bar");

    const filtered = await (await call(ctx, `${APP}/admin?frequency=training`, { headers: owner })).text();
    expect(filtered).toContain("ada@example.com");
    expect(filtered).not.toContain("=cmd@example.com");

    const id = ctx.tables.signups[0].id;
    const changed = await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "invited", back: "/admin?frequency=training" }, owner);
    expect(changed.headers.get("location")).toBe("/admin?frequency=training&done=invited");
    expect(ctx.tables.signups[0]).toMatchObject({ status: "invited" });
    expect(ctx.log.info).toHaveBeenCalledWith("waitlist status changed", { signup_id: id, status: "invited" });

    const offsite = await post(ctx, `${APP}/admin/signups/${id}/status`, { status: "waiting", back: "//evil.example/admin" }, owner);
    expect(offsite.headers.get("location")).toBe("/admin?done=waiting");

    const csv = await call(ctx, `${APP}/admin/export.csv`, { headers: owner });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toContain("place_in_line,name,email");
    expect(text).toContain("'@SUM(A1)");
    expect(text).toContain("'=cmd@example.com");
  });
});

describe("public demo", () => {
  it("shows sample signups without sign-in and marks every page as a demo", async () => {
    const ctx = makeCtx();
    for (const path of ["/", "/admin", "/thanks", "/missing"]) {
      const html = await (await call(ctx, `${DEMO}${path}`)).text();
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
      expect(html).toContain('href="https://userland.fun/examples/waitlist-app/"');
    }
    const admin = await (await call(ctx, `${DEMO}/admin`)).text();
    expect(admin).toContain("@example.com");
    expect(admin).toContain("people");

    // The landing count leaves out the samples the owner archived.
    const archived = sampleSignups().filter((row: { status: string }) => row.status === "archived").length;
    expect(archived).toBeGreaterThan(0);
    expect(await (await call(ctx, `${DEMO}/`)).text()).toContain(`<b>${sampleSignups().length - archived}</b> runners have already joined.`);
  });

  it("keeps the visitor's demo on message pages", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "gus@example.com" });
    const key = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";

    const repeat = await post(ctx, `${DEMO}/join`, { email: "gus@example.com", demo: key });
    expect(repeat.headers.get("location")).toBe(`/thanks?demo=${key}`);
    for (const page of [`/thanks?demo=${key}`, `/missing?demo=${key}`]) {
      const html = await (await call(ctx, `${DEMO}${page}`)).text();
      expect(html).toContain(`class="button button--volt" href="/?demo=${key}"`);
      expect(html).toContain(`<a href="/?demo=${key}">Go to the waitlist page</a>`);
    }
    // The answers form carries the demo key, so a failed answers post still links back to it.
    const statusHtml = await (await call(ctx, `${DEMO}${path}`)).text();
    expect(statusHtml).toContain(`class="questions"><input type="hidden" name="demo" value="${key}">`);
    const badAnswers = await post(ctx, `${DEMO}${path.replace(/[^/]+$/u, "wrong-token")}/answers`, { demo: key });
    expect(badAnswers.status).toBe(404);
    expect(await badAnswers.text()).toContain(`class="button button--volt" href="/?demo=${key}"`);
    const badChange = await post(ctx, `${DEMO}/admin/signups/x/status`, { status: "nope", demo: key });
    expect(badChange.status).toBe(400);
    expect(await badChange.text()).toContain(`href="/admin?demo=${key}"`);
  });

  it("deletes visitor signups after a day and caps the demo as a whole", async () => {
    const ctx = makeCtx();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-01T12:00:00Z") });
    const oldPath = await join(ctx, DEMO, { email: "old@example.com" });
    const oldKey = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${oldPath}`)).text())?.[1] ?? "";
    expect(ctx.tables["demo-signups"][0].demo_expires_at).toBe("2026-09-02T12:00:00.000Z");

    // A day later the old signup is gone from its owner's view, and the next write deletes it.
    vi.setSystemTime(new Date("2026-09-02T12:05:00Z"));
    expect(await (await call(ctx, `${DEMO}/admin?demo=${oldKey}&sort=newest`)).text()).not.toContain("old@example.com");
    await join(ctx, DEMO, { email: "new@example.com" });
    expect(ctx.tables["demo-signups"].map((row) => row.email)).toEqual(["new@example.com"]);

    // Fill the demo to its limit (MAX_DEMO_ROWS = 400) with other visitors' rows.
    const rows = ctx.data.collection("demo-signups");
    for (let index = 0; index < 399; index += 1) {
      await rows.create({ demo_key: `k${index}`, email: `v${index}@example.com`, demo_expires_at: "2026-09-03T12:00:00.000Z" });
    }
    const full = await post(ctx, `${DEMO}/join`, { email: "late@example.com" });
    expect(full.status).toBe(429);
    expect(await full.text()).toContain("The demo is busy right now.");
    expect(ctx.tables["demo-signups"]).toHaveLength(400);
    vi.useRealTimers();
  });

  it("never shows one visitor's signups to another visitor", async () => {
    const ctx = makeCtx();
    const alicePath = await join(ctx, DEMO, { email: "alice@example.com", name: "Alice" });
    const bobPath = await join(ctx, DEMO, { email: "bob@example.com", name: "Bob" });

    const keyFrom = async (path: string) => /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";
    const aliceKey = await keyFrom(alicePath);
    const bobKey = await keyFrom(bobPath);
    expect(aliceKey).not.toBe("");
    expect(aliceKey).not.toBe(bobKey);

    const aliceView = await (await call(ctx, `${DEMO}/admin?demo=${aliceKey}&sort=newest`)).text();
    expect(aliceView).toContain("alice@example.com");
    expect(aliceView).not.toContain("bob@example.com");

    const bobView = await (await call(ctx, `${DEMO}/admin?demo=${bobKey}&sort=newest`)).text();
    expect(bobView).toContain("bob@example.com");
    expect(bobView).not.toContain("alice@example.com");

    // The CSV holds every row in the view, so it checks the whole list, not just one page.
    const exportFor = async (query: string) => await (await call(ctx, `${DEMO}/admin/export.csv${query}`)).text();
    expect(await exportFor(`?demo=${aliceKey}`)).toContain("alice@example.com");
    expect(await exportFor(`?demo=${aliceKey}`)).not.toContain("bob@example.com");
    expect(await exportFor(`?demo=${bobKey}`)).not.toContain("alice@example.com");
    const anonymous = await exportFor("");
    expect(anonymous).not.toContain("alice@example.com");
    expect(anonymous).not.toContain("bob@example.com");
    for (const path of ["/", "/admin", "/admin?sort=newest"]) {
      const html = await (await call(ctx, `${DEMO}${path}`)).text();
      expect(html).not.toContain("alice@example.com");
      expect(html).not.toContain("bob@example.com");
    }

    // Bob cannot change Alice's signup even with its id.
    const aliceId = ctx.tables["demo-signups"].find((row) => row.email === "alice@example.com")?.id;
    const attempt = await post(ctx, `${DEMO}/admin/signups/${aliceId}/status`, { status: "archived", demo: bobKey });
    expect(attempt.status).toBe(404);
    expect(ctx.tables["demo-signups"].find((row) => row.id === aliceId)?.status).toBe("waiting");

    // Nothing from the demo lands in the real signups collection.
    expect(ctx.tables.signups ?? []).toHaveLength(0);
  });

  it("keeps status changes on sample signups private to the visitor", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "carol@example.com" });
    const key = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${path}`)).text())?.[1] ?? "";
    const sample = sampleSignups().find((row: { status: string }) => row.status === "waiting");

    const response = await post(ctx, `${DEMO}/admin/signups/${sample.id}/status`, { status: "invited", demo: key });
    expect(response.headers.get("location")).toBe(`/admin?done=invited&demo=${key}`);

    const invited = async (query: string) => await (await call(ctx, `${DEMO}/admin/export.csv?status=invited${query}`)).text();
    expect(await invited(`&demo=${key}`)).toContain(sample.email);
    expect(await invited("")).not.toContain(sample.email);
    const otherVisitor = await join(ctx, DEMO, { email: "dave@example.com" });
    const otherKey = /demo=([a-f0-9]{32})/u.exec(await (await call(ctx, `${DEMO}${otherVisitor}`)).text())?.[1] ?? "";
    expect(await invited(`&demo=${otherKey}`)).not.toContain(sample.email);
  });

  it("lets a visitor test their invite link inside their own demo", async () => {
    const ctx = makeCtx();
    const path = await join(ctx, DEMO, { email: "dana@example.com", name: "Dana" });
    const html = await (await call(ctx, `${DEMO}${path}`)).text();
    const key = /demo=([a-f0-9]{32})/u.exec(html)?.[1] ?? "";
    const code = /\/r\/([A-Z0-9]+)/u.exec(html)?.[1] ?? "";

    // The private page explains that shared links start a separate demo, and links to the one that works.
    expect(html).toContain('class="demo-tip"');
    expect(html).toContain(`href="/?ref=${code}&amp;demo=${key}"`);
    // The logo keeps the visitor's demo.
    expect(html).toContain(`class="logo" href="/?demo=${key}"`);

    await join(ctx, DEMO, { email: "erin@example.com", ref: code, demo: key });
    expect(await (await call(ctx, `${DEMO}${path}`)).text()).toContain("<b>1</b> friend has joined");

    // The same link used by someone without this visitor's demo key does not reach their list.
    await join(ctx, DEMO, { email: "stranger@example.com", ref: code });
    expect(await (await call(ctx, `${DEMO}${path}`)).text()).toContain("<b>1</b> friend has joined");
  });
});

describe("waitlist rules", () => {
  it("orders by join time and moves people up for referrals", () => {
    const row = (id: string, minute: number, referrals = 0, status = "waiting") => ({
      id,
      joined_at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
      referrals,
      status
    });
    const rows = Array.from({ length: 15 }, (_, index) => row(`r${index}`, index));
    rows[14].referrals = 1;
    rows[0].status = "invited";
    const { positions, waitingCount } = rankWaitlist(rows);
    expect(waitingCount).toBe(14);
    expect(positions.get("r1")).toBe(1);
    expect(positions.get("r14")).toBe(4);
    expect(positions.has("r0")).toBe(false);
  });

  it("builds made-up sample signups with example.com emails only", () => {
    const samples = sampleSignups(new Date("2026-09-27T12:00:00Z"));
    expect(samples.length).toBeGreaterThan(100);
    expect(samples.every((row: { email: string }) => row.email.endsWith("@example.com"))).toBe(true);
    expect(new Set(samples.map((row: { email: string }) => row.email)).size).toBe(samples.length);
    expect(toCsv([], new Map())).toContain("place_in_line");
  });
});

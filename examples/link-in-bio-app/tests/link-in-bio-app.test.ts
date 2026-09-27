// @ts-expect-error Example server files are plain JavaScript app bundles.
import app, { toCsv } from "../server/index.js";

const APP = "https://kiln.example.test";
const DEMO = "https://link-in-bio-demo.apps.userland.fun";
const OWNER_COOKIE = "__Host-ul_session=owner-session";
const FAN_COOKIE = "__Host-ul_session=fan-session";

type Row = Record<string, any>;

// An in-memory stand-in for the Userland runtime ctx: data collections with
// exact-match `where`, plus app-user auth keyed by the session cookie.
function makeCtx() {
  const state: Record<string, Row[]> = { links: [], inbox: [] };
  let seq = 0;
  const users: Record<string, { id: string; email: string; roles: string[] }> = {
    "owner-session": { id: "u_owner", email: "wren@example.com", roles: ["owner"] },
    "fan-session": { id: "u_fan", email: "fan@example.com", roles: [] }
  };
  const sessionUser = (request: Request) => {
    const match = /__Host-ul_session=([^;]+)/.exec(request.headers.get("cookie") ?? "");
    return match ? (users[match[1]] ?? null) : null;
  };

  const data = {
    collection(name: string) {
      const rows = state[name];
      if (!rows) throw new Error(`Unknown collection ${name}`);
      return {
        async create(input: Row) {
          const now = new Date().toISOString();
          const row = { ...input, id: `${name}_${++seq}`, created_at: now, updated_at: now };
          rows.push(row);
          return { ...row };
        },
        async get(id: string) {
          const row = rows.find((r) => r.id === id);
          return row ? { ...row } : null;
        },
        async update(id: string, patch: Row) {
          const index = rows.findIndex((r) => r.id === id);
          if (index === -1) throw new Error(`Missing row ${id}`);
          rows[index] = { ...rows[index], ...patch };
          return { ...rows[index] };
        },
        async delete(id: string) {
          const index = rows.findIndex((r) => r.id === id);
          if (index !== -1) rows.splice(index, 1);
        },
        async list(query: { where?: Row; order_by?: Array<{ field: string; direction?: string }>; limit?: number } = {}) {
          let out = rows.filter((r) => Object.entries(query.where ?? {}).every(([k, v]) => r[k] === v));
          for (const order of query.order_by ?? []) {
            out = [...out].sort((a, b) => String(a[order.field]).localeCompare(String(b[order.field])) * (order.direction === "desc" ? -1 : 1));
          }
          return { rows: out.slice(0, query.limit ?? 50).map((r) => ({ ...r })) };
        }
      };
    }
  };

  return {
    state,
    data,
    auth: {
      async currentUser(request: Request) {
        return sessionUser(request);
      },
      async requireRole(request: Request, role: string) {
        const user = sessionUser(request);
        // Like the Userland runtime: plain errors, no status.
        if (!user) throw new Error("Authentication required.");
        if (!user.roles.includes(role)) throw new Error("Required role is missing.");
        return user;
      }
    },
    log: { info: vi.fn(async () => {}), error: vi.fn(async () => {}) }
  };
}

type Ctx = ReturnType<typeof makeCtx>;

// The UTC hour `offset` hours from now as YYYYMMDDHH, the prefix of a demo key.
function hourStamp(offset: number) {
  return new Date(Date.now() + offset * 3_600_000).toISOString().slice(0, 13).replace(/[-T]/g, "");
}

function get(ctx: Ctx, url: string, headers: Record<string, string> = {}) {
  return app.fetch(new Request(url, { headers }), ctx) as Promise<Response>;
}

function post(ctx: Ctx, url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString()
    }),
    ctx
  ) as Promise<Response>;
}

async function addStarterLinks(ctx: Ctx) {
  const res = await post(ctx, `${APP}/admin/links/starter`, {}, { cookie: OWNER_COOKIE });
  expect(res.status).toBe(303);
}

describe("public page", () => {
  it("shows the profile, featured products, and visible links in order", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const hidden = ctx.state.links.find((l) => l.title === "Wholesale and cafe orders")!;
    hidden.visible = false;

    const res = await get(ctx, `${APP}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Kiln &amp; Crumb");
    expect(html).toContain("Fresh from the kiln");
    expect(html.indexOf("Speckled Pie Dish")).toBeLessThan(html.indexOf("Morning Mugs"));
    expect(html).not.toContain("Wholesale and cafe orders");
    // A normal copy of the app is indexable and has no demo ribbon.
    expect(html).not.toContain('name="robots"');
    expect(html).not.toContain("Demo app");
  });

  it("escapes link text so owners can't break the page", async () => {
    const ctx = makeCtx();
    await ctx.data.collection("links").create({ title: '<script>alert("x")</script>', url: "https://example.com", note: "", price: "", picture: "mug", featured: false, visible: true, position: 1, clicks: 0, demo_key: "" });
    const html = await (await get(ctx, `${APP}/`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("counts a tap and redirects to the link", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const res = await get(ctx, `${APP}/go/${link.id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(link.url);
    expect(ctx.state.links[0].clicks).toBe(1);
  });
});

describe("email list and contact form", () => {
  it("adds a signup once per address", async () => {
    const ctx = makeCtx();
    const first = await post(ctx, `${APP}/subscribe`, { name: "Ada", email: "ada@example.com" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/thanks?kind=signup");
    await post(ctx, `${APP}/subscribe`, { email: "ADA@example.com" });
    expect(ctx.state.inbox).toHaveLength(1);
    expect(ctx.state.inbox[0]).toMatchObject({ kind: "signup", email: "ada@example.com", status: "new", demo_key: "" });
  });

  it("rejects a bad email and keeps what the visitor typed", async () => {
    const ctx = makeCtx();
    const res = await post(ctx, `${APP}/subscribe`, { name: "Ada", email: "not-an-email" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('value="not-an-email"');
    expect(ctx.state.inbox).toHaveLength(0);
  });

  it("rejects addresses that would add fields to the owner's reply email", async () => {
    const ctx = makeCtx();
    for (const email of ["x@y.com?bcc=evil%40ex.com", "x@y.com&cc=a@b.com", "x@y.com#frag", "x%40y@z.com"]) {
      const res = await post(ctx, `${APP}/contact`, { name: "Ada", email, topic: "Wholesale", message: "Hi" });
      expect(res.status).toBe(422);
    }
    expect(ctx.state.inbox).toHaveLength(0);

    await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada.o'neil+shop@mail.example.co.uk", topic: "Wholesale", message: "Hi" });
    const inbox = await (await get(ctx, `${APP}/admin`, { cookie: OWNER_COOKIE })).text();
    expect(inbox).toContain('href="mailto:ada.o&#39;neil+shop@mail.example.co.uk?subject=');
  });

  it("quietly ignores bots that fill in the hidden field", async () => {
    const ctx = makeCtx();
    const res = await post(ctx, `${APP}/contact`, { name: "Bot", email: "bot@example.com", topic: "Wholesale", message: "Buy now", website: "https://spam.example" });
    expect(res.status).toBe(303);
    expect(ctx.state.inbox).toHaveLength(0);
  });

  it("stores a contact message and validates length and topic", async () => {
    const ctx = makeCtx();
    const tooLong = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "x".repeat(2001) });
    expect(tooLong.status).toBe(422);
    const badTopic = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Crypto", message: "Hello" });
    expect(badTopic.status).toBe(422);
    const ok = await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "Hello <b>Wren</b>" });
    expect(ok.status).toBe(303);
    expect(ctx.state.inbox[0]).toMatchObject({ kind: "message", topic: "Wholesale", message: "Hello <b>Wren</b>" });

    const inbox = await (await get(ctx, `${APP}/admin`, { cookie: OWNER_COOKIE })).text();
    expect(inbox).toContain("Hello &lt;b&gt;Wren&lt;/b&gt;");
  });
});

describe("owner view outside the demo", () => {
  it("sends signed-out visitors to sign in", async () => {
    const ctx = makeCtx();
    const res = await get(ctx, `${APP}/admin/links`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/_userland/auth/login?return_to=%2Fadmin%2Flinks");
  });

  it("refuses signed-out changes", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const link = ctx.state.links[0];
    const res = await post(ctx, `${APP}/admin/links/${link.id}`, { action: "delete" });
    expect(res.status).toBe(401);
    const csv = await get(ctx, `${APP}/admin/email-list.csv`);
    expect(csv.status).toBe(303);
    expect(ctx.state.links).toHaveLength(8);
  });

  it("refuses app users without the owner role", async () => {
    const ctx = makeCtx();
    const res = await get(ctx, `${APP}/admin`, { cookie: FAN_COOKIE });
    expect(res.status).toBe(403);
    const change = await post(ctx, `${APP}/admin/links/starter`, {}, { cookie: FAN_COOKIE });
    expect(change.status).toBe(403);
    expect(ctx.state.links).toHaveLength(0);
  });

  it("refuses cross-site posts even with an owner session", async () => {
    const ctx = makeCtx();
    const res = await post(ctx, `${APP}/admin/links/starter`, {}, { cookie: OWNER_COOKIE, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(ctx.state.links).toHaveLength(0);
  });

  it("lets the owner manage links and the inbox", async () => {
    const ctx = makeCtx();
    const owner = { cookie: OWNER_COOKIE, origin: APP };
    const add = await post(ctx, `${APP}/admin/links`, { title: "New mug", url: "https://shop.example.com/mug", picture: "mug", featured: "yes", visible: "yes", price: "$30" }, owner);
    expect(add.status).toBe(303);
    const bad = await post(ctx, `${APP}/admin/links`, { title: "Bad", url: "javascript:alert(1)" }, owner);
    expect(bad.status).toBe(422);
    expect(ctx.state.links).toHaveLength(1);

    const id = ctx.state.links[0].id;
    await post(ctx, `${APP}/admin/links/${id}`, { action: "hide" }, owner);
    expect(ctx.state.links[0].visible).toBe(false);
    await post(ctx, `${APP}/admin/links/${id}`, { action: "save", title: "Renamed mug", url: "https://shop.example.com/mug2", picture: "mug", visible: "yes" }, owner);
    expect(ctx.state.links[0]).toMatchObject({ title: "Renamed mug", visible: true, featured: false });

    await post(ctx, `${APP}/contact`, { name: "Ada", email: "ada@example.com", topic: "Wholesale", message: "Hi" });
    const message = ctx.state.inbox[0];
    const status = await post(ctx, `${APP}/admin/inbox/${message.id}`, { status: "replied" }, owner);
    expect(status.status).toBe(303);
    expect(ctx.state.inbox[0].status).toBe("replied");

    await post(ctx, `${APP}/admin/links/${id}`, { action: "delete" }, owner);
    expect(ctx.state.links).toHaveLength(0);
  });

  it("moves links up and down", async () => {
    const ctx = makeCtx();
    await addStarterLinks(ctx);
    const second = ctx.state.links.find((l) => l.position === 2)!;
    await post(ctx, `${APP}/admin/links/${second.id}`, { action: "up" }, { cookie: OWNER_COOKIE });
    const html = await (await get(ctx, `${APP}/`)).text();
    expect(html.indexOf("Morning Mugs")).toBeLessThan(html.indexOf("Speckled Pie Dish"));
  });

  it("exports the email list as CSV with formula-safe cells", () => {
    const csv = toCsv([{ email: "ada@example.com", name: "=HYPERLINK(\"x\")", received_at: "2026-09-27T00:00:00.000Z" }]);
    expect(csv).toContain('"email","name","joined"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("public demo", () => {
  async function newVisitor(ctx: Ctx) {
    const res = await get(ctx, `${DEMO}/admin`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    const key = /visit=([^&]+)/.exec(location)![1];
    return key;
  }

  it("opens the owner view without sign-in and marks every page noindex", async () => {
    const ctx = makeCtx();
    const key = await newVisitor(ctx);
    const inbox = await get(ctx, `${DEMO}/admin?visit=${key}`);
    expect(inbox.status).toBe(200);
    const html = await inbox.text();
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain("https://userland.fun/examples/link-in-bio-app/");
    expect(html).toContain("Priya Raman"); // sample message
    for (const path of ["/", "/contact", "/thanks?kind=signup", `/admin/links?visit=${key}`]) {
      const page = await (await get(ctx, `${DEMO}${path}`)).text();
      expect(page).toContain('<meta name="robots" content="noindex,follow">');
      expect(page).toContain("See how it's made");
    }
  });

  it("never shows one visitor's submissions or changes to another", async () => {
    const ctx = makeCtx();
    // Visitor A signs up from the public page with no key yet.
    const signup = await post(ctx, `${DEMO}/subscribe`, { email: "visitor-a@example.com" });
    expect(signup.status).toBe(303);
    const keyA = /visit=([^&]+)/.exec(signup.headers.get("location")!)![1];
    await post(ctx, `${DEMO}/contact`, { visit: keyA, name: "Visitor A", email: "visitor-a@example.com", topic: "Collab", message: "Private note from A" });

    const keyB = await newVisitor(ctx);
    expect(keyB).not.toBe(keyA);

    const aList = await (await get(ctx, `${DEMO}/admin?tab=list&visit=${keyA}`)).text();
    const aInbox = await (await get(ctx, `${DEMO}/admin?visit=${keyA}`)).text();
    expect(aList).toContain("visitor-a@example.com");
    expect(aInbox).toContain("Private note from A");

    const bList = await (await get(ctx, `${DEMO}/admin?tab=list&visit=${keyB}`)).text();
    const bInbox = await (await get(ctx, `${DEMO}/admin?visit=${keyB}`)).text();
    const noKey = await (await get(ctx, `${DEMO}/admin?tab=list`)).text();
    for (const html of [bList, bInbox, noKey]) {
      expect(html).not.toContain("visitor-a@example.com");
      expect(html).not.toContain("Private note from A");
    }

    // A archives a sample message; B still sees it as new.
    const aPriya = ctx.state.inbox.find((r) => r.demo_key === keyA && r.name === "Priya Raman")!;
    await post(ctx, `${DEMO}/admin/inbox/${aPriya.id}`, { visit: keyA, status: "archived" });
    const bPriya = ctx.state.inbox.find((r) => r.demo_key === keyB && r.name === "Priya Raman")!;
    expect(bPriya.status).toBe("new");

    // B can't change A's rows by guessing ids.
    const cross = await post(ctx, `${DEMO}/admin/inbox/${aPriya.id}`, { visit: keyB, status: "new" });
    expect(cross.status).toBe(404);
    expect(ctx.state.inbox.find((r) => r.id === aPriya.id)!.status).toBe("archived");

    // A hides a link on their copy of the page; B's page and the shared page keep it.
    const aLink = ctx.state.links.find((r) => r.demo_key === keyA && r.title === "Speckled Pie Dish")!;
    await post(ctx, `${DEMO}/admin/links/${aLink.id}`, { visit: keyA, action: "hide" });
    expect(await (await get(ctx, `${DEMO}/?visit=${keyA}`)).text()).not.toContain("Speckled Pie Dish");
    expect(await (await get(ctx, `${DEMO}/?visit=${keyB}`)).text()).toContain("Speckled Pie Dish");
    expect(await (await get(ctx, `${DEMO}/`)).text()).toContain("Speckled Pie Dish");
  });

  it("shows where a link would go instead of leaving the demo", async () => {
    const ctx = makeCtx();
    await get(ctx, `${DEMO}/`); // adds the shared starter links
    const link = ctx.state.links.find((r) => r.demo_key === "")!;
    const res = await get(ctx, `${DEMO}/go/${link.id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("This button would open");
  });

  it("ignores made-up or expired visitor keys", async () => {
    const ctx = makeCtx();
    for (const stale of ["2020010100-aaaaaaaaaaaaaaaaaaaaaaaa", "20200101-aaaaaaaaaaaaaaaaaaaaaaaa", `${hourStamp(-7)}-aaaaaaaaaaaaaaaaaaaaaaaa`]) {
      const res = await get(ctx, `${DEMO}/admin?visit=${stale}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).not.toContain(stale);
    }
    // A key from earlier today still works.
    const recent = `${hourStamp(-1)}-bbbbbbbbbbbbbbbbbbbbbbbb`;
    ctx.state.inbox.push({ id: "recent-1", kind: "message", name: "Recent", email: "r@example.com", topic: "Collab", message: "Still here", status: "new", received_at: new Date().toISOString(), demo_key: recent });
    const ok = await get(ctx, `${DEMO}/admin?visit=${recent}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Still here");
  });

  it("never stores a typed email address in full", async () => {
    const ctx = makeCtx();
    const signup = await post(ctx, `${DEMO}/subscribe`, { email: "alice.smith@realmail.com" });
    const key = /visit=([^&]+)/.exec(signup.headers.get("location")!)![1];
    await post(ctx, `${DEMO}/contact`, { visit: key, name: "Al", email: "al@work.co.uk", topic: "Collab", message: "Hello there" });
    const stored = ctx.state.inbox.filter((r) => r.demo_key === key).map((r) => r.email);
    expect(stored).toContain("a\u2022\u2022\u2022@r\u2022\u2022\u2022.com");
    expect(stored).toContain("a\u2022\u2022\u2022@w\u2022\u2022\u2022.uk");
    expect(JSON.stringify(ctx.state.inbox)).not.toContain("realmail");
    const inbox = await (await get(ctx, `${DEMO}/admin?visit=${key}`)).text();
    expect(inbox).toContain("share <a href=\"https://link-in-bio-demo.apps.userland.fun/\">");
    // Hidden addresses show as plain text, not as email links.
    expect(inbox).not.toContain("mailto:a\u2022");
    expect(inbox).toContain("a\u2022\u2022\u2022@w\u2022\u2022\u2022.uk");
    // Two different real addresses that hide the same way stay two signups.
    await post(ctx, `${DEMO}/subscribe`, { visit: key, email: "anne@rainmail.com" });
    expect(ctx.state.inbox.filter((r) => r.demo_key === key && r.email === "a\u2022\u2022\u2022@r\u2022\u2022\u2022.com" && r.kind === "signup")).toHaveLength(2);
    const list = await (await get(ctx, `${DEMO}/admin?tab=list&visit=${key}`)).text();
    expect(list).toContain("Download list (spreadsheet)");
    expect(list).toContain("a\u2022\u2022\u2022@r\u2022\u2022\u2022.com");
    expect(list).not.toContain("mailto:a\u2022");
  });

  it("tells demo visitors that made-up details are fine", async () => {
    const ctx = makeCtx();
    expect(await (await get(ctx, `${DEMO}/`)).text()).toContain("Made-up details work fine");
    expect(await (await get(ctx, `${DEMO}/contact`)).text()).toContain("Made-up details work fine");
    expect(await (await get(ctx, `${APP}/`)).text()).not.toContain("Made-up details");
  });

  it("cleans up duplicate starter links from simultaneous first visits", async () => {
    const ctx = makeCtx();
    await Promise.all([get(ctx, `${DEMO}/`), get(ctx, `${DEMO}/`), get(ctx, `${DEMO}/`)]);
    await get(ctx, `${DEMO}/`);
    const titles = ctx.state.links.filter((r) => r.demo_key === "").map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("treats broken addresses as not found instead of an error", async () => {
    const ctx = makeCtx();
    expect((await get(ctx, `${DEMO}/go/%E0%A4%A`)).status).toBe(404);
    const key = await newVisitor(ctx);
    expect((await get(ctx, `${DEMO}/admin/links/%E0%A4%A?visit=${key}`)).status).toBe(404);
    expect((await post(ctx, `${DEMO}/admin/inbox/%E0%A4%A`, { visit: key, status: "new" })).status).toBe(404);
    expect(ctx.log.error).not.toHaveBeenCalled();
  });
});

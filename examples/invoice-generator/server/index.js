// Invoice Generator: a public quote request page, a private client link for each
// quote and invoice, and a studio desk for the owner.
//
// Public routes
//   GET  /                        studio page with the quote request form
//   POST /request                 save a quote request (new client + quote)
//   GET  /request/sent            confirmation
//   GET  /p/:token                client view of a sent quote or invoice (printable)
//   POST /p/:token/respond        client accepts or declines a sent quote
//
// Owner routes (app user with the "owner" role)
//   GET  /desk                    documents, totals, and new requests
//   GET  /desk/new?kind=quote     new quote or invoice form
//   POST /desk/documents          create a quote or invoice
//   GET  /desk/documents/:id      printable document with status actions
//   GET  /desk/documents/:id/edit edit a draft or price a request
//   POST /desk/documents/:id      save edits
//   POST /desk/documents/:id/status   change status
//   POST /desk/documents/:id/convert  turn a quote into an invoice
//   GET  /desk/clients            client list and add form
//   POST /desk/clients            add a client
//   GET  /desk/clients/:id        client details and documents
//   POST /desk/clients/:id        save client details

import { STUDIO } from "./studio.js";
import * as store from "./store.js";
import * as views from "./views.js";
import * as demo from "./demo.js"; // demo

const OWNER_ROLE = "owner";
const MAX_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store"
};

const FLASH = {
  created: "Saved as a draft.",
  saved: "Changes saved.",
  converted: "Invoice created from the quote. Check the dates, then mark it as sent.",
  "client-added": "Client added.",
  "client-saved": "Client details saved.",
  "status-draft": "Moved back to draft.",
  "status-sent": "Marked as sent. Copy the client link below and send it from your email.",
  "status-accepted": "Marked as accepted.",
  "status-declined": "Marked as declined.",
  "status-paid": "Marked as paid.",
  "status-void": "Invoice voided.",
  accepted: "Thank you. The quote is marked as accepted. We'll email you to confirm dates.",
  declined: "Thanks for letting us know. The quote is marked as declined."
};

function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...headers } });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Request context: which workspace this request reads and writes, and how
// links are built. Outside the demo, everything lives in the "main" workspace.

function requestContext(request) {
  let rc = {
    url: new URL(request.url),
    demo: false,
    workspace: store.MAIN_WORKSPACE,
    link: (path) => path,
    robots: null,
    banner: () => "",
    footer: "",
    signOut: true
  };
  rc = demo.applyDemo(rc); // demo
  return rc;
}

/**
 * The owner gate. Returns null when the request may continue, or a Response.
 * Uses ctx.auth.requireRole so only app users with the "owner" role get in.
 */
async function ownerGate(request, ctx, rc) {
  if (rc.demo) return rc.workspace ? null : request.method === "GET" ? html(views.demoStartPage(rc)) : redirect("/desk"); // demo
  try {
    await ctx.auth.requireRole(request, OWNER_ROLE);
    return null;
  } catch {
    const user = await ctx.auth.currentUser(request).catch(() => null);
    if (!user && request.method === "GET") {
      const returnTo = rc.url.pathname + rc.url.search;
      return redirect(`/_userland/auth/login?return_to=${encodeURIComponent(returnTo)}`);
    }
    return html(
      views.messagePage(rc, {
        title: user ? "Owner access only" : "Please sign in",
        message: user ? "This account can't open the studio desk. Ask the owner to invite you." : "Sign in to use the studio desk.",
        actionHtml: user ? `<p><a href="/_userland/auth/logout">Sign out</a></p>` : `<p><a href="/_userland/auth/login?return_to=%2Fdesk">Sign in</a></p>`
      }),
      user ? 403 : 401
    );
  }
}

/** Reads a small form body, refusing cross-site posts and oversized bodies. */
async function readForm(request, rc) {
  const origin = request.headers.get("origin");
  if (origin && origin !== rc.url.origin) throw html(views.messagePage(rc, { title: "Request blocked", message: "This form has to be sent from this site." }), 403);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw html(views.messagePage(rc, { title: "Too much text", message: "That was more text than this form accepts." }), 413);
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) {
    throw html(views.messagePage(rc, { title: "Unsupported form", message: "Please use the form on this site." }), 415);
  }
  return await request.formData();
}

function notFound(rc) {
  return html(views.messagePage(rc, { title: "Page not found", message: "This page doesn't exist, or the link has expired.", actionHtml: `<p><a href="${views.esc(rc.link("/"))}">Go to the studio page</a></p>` }), 404);
}

// ---------------------------------------------------------------------------
// Public handlers

async function submitRequest(request, ctx, rc) {
  const form = await readForm(request, rc);
  // Honeypot: people never see the "website" field, bots fill it in. Pretend it worked.
  if (cleanTrap(form.get("website"))) return redirect(rc.link("/request/sent"));

  const { values, service, errors } = store.parseRequestForm(form);
  if (Object.keys(errors).length) return html(views.homePage(rc, { values, errors }), 422);

  if (rc.demo && !rc.workspace) rc = await demo.openWorkspace(rc, ctx); // demo
  const limit = rc.demo ? demo.demoLimitMessage(await store.countRows(ctx.data, rc.workspace), "documents") : null; // demo
  if (limit) return html(views.homePage(rc, { values, errors: { limit } }), 422); // demo

  let client = await store.findClientByEmail(ctx.data, rc.workspace, values.email);
  if (!client) client = await store.createClient(ctx.data, rc.workspace, { name: values.name, company: values.company, email: values.email });
  const quote = await store.createDocument(ctx.data, rc.workspace, "quote", {
    client_id: client.id,
    title: service.name,
    status: "requested",
    lines: [],
    request_message: values.message
  });
  await ctx.log.info("quote requested", { document_id: quote.id, number: quote.number, service: service.id });
  return redirect(rc.link("/request/sent"));
}

function cleanTrap(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function clientDocument(request, ctx, rc, token) {
  const document = await store.getDocumentByToken(ctx.data, token);
  if (!document) return notFound(rc);
  const client = await ctx.data.collection("clients").get(document.client_id);
  let deskHref = null;
  if (rc.demo && document.workspace === rc.workspace) deskHref = rc.link(`/desk/documents/${document.id}`); // demo
  const flash = FLASH[rc.url.searchParams.get("done")] ?? "";
  return html(views.clientDocumentPage(rc, { document, client, deskHref, flash }));
}

async function respond(request, ctx, rc, token) {
  const form = await readForm(request, rc);
  const answer = form.get("answer") === "accept" ? "accept" : "decline";
  const updated = await store.respondToQuote(ctx.data, token, answer);
  if (!updated) return redirect(rc.link(`/p/${token}`));
  await ctx.log.info(answer === "accept" ? "quote accepted by client" : "quote declined by client", { document_id: updated.id, number: updated.number });
  return redirect(rc.link(`/p/${token}?done=${answer === "accept" ? "accepted" : "declined"}`));
}

// ---------------------------------------------------------------------------
// Owner handlers

async function desk(ctx, rc) {
  const [documents, clients] = await Promise.all([store.listDocuments(ctx.data, rc.workspace), store.listClients(ctx.data, rc.workspace)]);
  const view = ["quotes", "invoices", "requests"].includes(rc.url.searchParams.get("view")) ? rc.url.searchParams.get("view") : "all";
  const flash = FLASH[rc.url.searchParams.get("done")] ?? "";
  return html(views.deskPage(rc, { documents, clients, view, summary: store.summarize(documents), flash }));
}

async function newDocumentForm(ctx, rc) {
  const kind = rc.url.searchParams.get("kind") === "invoice" ? "invoice" : "quote";
  const clients = await store.listClients(ctx.data, rc.workspace);
  const clientId = rc.url.searchParams.get("client") ?? "";
  const values = {
    client_id: clients.some((client) => client.id === clientId) ? clientId : "",
    issue_date: store.today(),
    due_date: store.addDays(store.today(), kind === "quote" ? STUDIO.quoteValidDays : STUDIO.paymentTermsDays),
    tax_percent: String(STUDIO.defaultTaxPercent),
    notes: kind === "quote" ? STUDIO.quoteNotes : STUDIO.invoiceNotes
  };
  return html(views.documentFormPage(rc, { kind, clients, values }));
}

async function createDocument(request, ctx, rc) {
  const form = await readForm(request, rc);
  const kind = form.get("kind") === "invoice" ? "invoice" : "quote";
  const parsed = store.parseDocumentForm(form);
  if (form.get("intent") === "add-line") {
    // "Add a line" without JavaScript: show the same form again with one more empty row.
    const clients = await store.listClients(ctx.data, rc.workspace);
    return html(views.documentFormPage(rc, { kind, clients, values: parsed.values, extraRow: true }));
  }
  if (!parsed.errors.client_id && !(await store.getClient(ctx.data, rc.workspace, parsed.values.client_id))) parsed.errors.client_id = "Choose a client.";
  const limit = rc.demo ? demo.demoLimitMessage(await store.countRows(ctx.data, rc.workspace), "documents") : null; // demo
  if (limit) parsed.errors.limit = limit; // demo
  if (Object.keys(parsed.errors).length) {
    const clients = await store.listClients(ctx.data, rc.workspace);
    return html(views.documentFormPage(rc, { kind, clients, values: parsed.values, errors: parsed.errors }), 422);
  }
  const document = await store.createDocument(ctx.data, rc.workspace, kind, { ...parsed.values, lines: parsed.lines, taxPercent: parsed.taxPercent });
  await ctx.log.info(`${kind} created`, { document_id: document.id, number: document.number, total_cents: document.total_cents });
  return redirect(rc.link(`/desk/documents/${document.id}?done=created`));
}

async function showDocument(ctx, rc, id) {
  const document = await store.getDocument(ctx.data, rc.workspace, id);
  if (!document) return notFound(rc);
  const client = await store.getClient(ctx.data, rc.workspace, document.client_id);
  const relatedId = document.kind === "quote" ? document.invoice_id : document.quote_id;
  const related = relatedId ? await store.getDocument(ctx.data, rc.workspace, relatedId) : null;
  const shared = ["sent", "accepted", "declined", "converted", "paid"].includes(document.status);
  const code = rc.url.searchParams.get("done");
  return html(
    views.documentPage(rc, {
      document,
      client,
      related,
      // The copyable link never includes the demo key, so sharing it can't expose a visitor's desk.
      clientUrl: shared ? `${rc.url.origin}/p/${document.public_token}` : null,
      clientViewHref: rc.link(`/p/${document.public_token}`),
      flash: FLASH[code] ?? "",
      error: code === "not-allowed" ? "That change isn't available for this document any more." : ""
    })
  );
}

async function editDocumentForm(ctx, rc, id) {
  const document = await store.getDocument(ctx.data, rc.workspace, id);
  if (!document) return notFound(rc);
  if (!store.isEditable(document)) return redirect(rc.link(`/desk/documents/${id}`));
  const clients = await store.listClients(ctx.data, rc.workspace);
  const values = views.documentFormValues(document);
  if (document.status === "requested") {
    values.issue_date = store.today();
    values.due_date = store.addDays(values.issue_date, STUDIO.quoteValidDays);
    values.notes = document.notes || STUDIO.quoteNotes;
  }
  return html(views.documentFormPage(rc, { kind: document.kind, document, clients, values, requestMessage: document.request_message }));
}

async function saveDocument(request, ctx, rc, id) {
  const document = await store.getDocument(ctx.data, rc.workspace, id);
  if (!document) return notFound(rc);
  if (!store.isEditable(document)) return redirect(rc.link(`/desk/documents/${id}?done=not-allowed`));
  const form = await readForm(request, rc);
  const parsed = store.parseDocumentForm(form);
  if (form.get("intent") === "add-line") {
    const clients = await store.listClients(ctx.data, rc.workspace);
    return html(views.documentFormPage(rc, { kind: document.kind, document, clients, values: parsed.values, requestMessage: document.request_message, extraRow: true }));
  }
  if (!parsed.errors.client_id && !(await store.getClient(ctx.data, rc.workspace, parsed.values.client_id))) parsed.errors.client_id = "Choose a client.";
  if (Object.keys(parsed.errors).length) {
    const clients = await store.listClients(ctx.data, rc.workspace);
    return html(views.documentFormPage(rc, { kind: document.kind, document, clients, values: parsed.values, errors: parsed.errors, requestMessage: document.request_message }), 422);
  }
  const updated = await store.updateDocument(ctx.data, rc.workspace, id, { ...parsed.values, lines: parsed.lines, taxPercent: parsed.taxPercent });
  await ctx.log.info(`${document.kind} updated`, { document_id: id, number: document.number, total_cents: updated.total_cents });
  return redirect(rc.link(`/desk/documents/${id}?done=saved`));
}

async function changeStatus(request, ctx, rc, id) {
  const form = await readForm(request, rc);
  const status = String(form.get("status") ?? "");
  const updated = await store.changeStatus(ctx.data, rc.workspace, id, status);
  if (!updated) return redirect(rc.link(`/desk/documents/${id}?done=not-allowed`));
  await ctx.log.info(`${updated.kind} status changed`, { document_id: id, number: updated.number, status });
  return redirect(rc.link(`/desk/documents/${id}?done=status-${status}`));
}

async function convert(request, ctx, rc, id) {
  await readForm(request, rc);
  const limit = rc.demo ? demo.demoLimitMessage(await store.countRows(ctx.data, rc.workspace), "documents") : null; // demo
  if (limit) return redirect(rc.link(`/desk/documents/${id}?done=not-allowed`)); // demo
  const invoice = await store.convertQuote(ctx.data, rc.workspace, id);
  if (!invoice) return redirect(rc.link(`/desk/documents/${id}?done=not-allowed`));
  await ctx.log.info("quote converted to invoice", { quote_id: id, invoice_id: invoice.id, number: invoice.number });
  return redirect(rc.link(`/desk/documents/${invoice.id}?done=converted`));
}

async function clients(ctx, rc, { values = {}, errors = {}, status = 200 } = {}) {
  const [list, documents] = await Promise.all([store.listClients(ctx.data, rc.workspace), store.listDocuments(ctx.data, rc.workspace)]);
  const flash = FLASH[rc.url.searchParams.get("done")] ?? "";
  return html(views.clientsPage(rc, { clients: list, documents, values, errors, flash }), status);
}

async function addClient(request, ctx, rc) {
  const form = await readForm(request, rc);
  const { values, errors } = store.parseClientForm(form);
  if (!errors.email && (await store.findClientByEmail(ctx.data, rc.workspace, values.email))) errors.email = "A client with this email already exists.";
  const limit = rc.demo ? demo.demoLimitMessage(await store.countRows(ctx.data, rc.workspace), "clients") : null; // demo
  if (limit) errors.limit = limit; // demo
  if (Object.keys(errors).length) return await clients(ctx, rc, { values, errors, status: 422 });
  const client = await store.createClient(ctx.data, rc.workspace, values);
  await ctx.log.info("client added", { client_id: client.id });
  return redirect(rc.link(`/desk/clients/${client.id}?done=client-added`));
}

async function showClient(ctx, rc, id, { values = null, errors = {}, status = 200 } = {}) {
  const client = await store.getClient(ctx.data, rc.workspace, id);
  if (!client) return notFound(rc);
  const documents = await store.listDocuments(ctx.data, rc.workspace, { client_id: client.id });
  const flash = FLASH[rc.url.searchParams.get("done")] ?? "";
  return html(views.clientPage(rc, { client, documents, values: values ?? client, errors, flash }), status);
}

async function saveClient(request, ctx, rc, id) {
  const client = await store.getClient(ctx.data, rc.workspace, id);
  if (!client) return notFound(rc);
  const form = await readForm(request, rc);
  const { values, errors } = store.parseClientForm(form);
  if (!errors.email && values.email !== client.email && (await store.findClientByEmail(ctx.data, rc.workspace, values.email))) errors.email = "Another client already uses this email.";
  if (Object.keys(errors).length) return await showClient(ctx, rc, id, { values, errors, status: 422 });
  await store.updateClient(ctx.data, rc.workspace, id, values);
  await ctx.log.info("client updated", { client_id: id });
  return redirect(rc.link(`/desk/clients/${id}?done=client-saved`));
}

async function openDemoDesk(request, ctx, rc) { // demo
  await readForm(request, rc); // demo
  return redirect((await demo.openWorkspace(rc, ctx)).link("/desk")); // demo
} // demo

// ---------------------------------------------------------------------------
// Router

async function route(request, ctx) {
  const rc = requestContext(request);
  const method = request.method;
  const path = rc.url.pathname.replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);

  if (rc.showcase && parts[0] !== "desk") return redirect(demo.showcaseTarget(rc, method)); // demo

  // Public pages
  if (path === "/" && method === "GET") return html(views.homePage(rc));
  if (path === "/request" && method === "POST") return await submitRequest(request, ctx, rc);
  if (path === "/request/sent" && method === "GET") {
    let deskHref = null;
    if (rc.demo && rc.workspace) deskHref = rc.link("/desk?view=requests"); // demo
    return html(views.requestSentPage(rc, { deskHref }));
  }
  if (parts[0] === "p" && parts.length === 2 && method === "GET") return await clientDocument(request, ctx, rc, parts[1]);
  if (parts[0] === "p" && parts.length === 3 && parts[2] === "respond" && method === "POST") return await respond(request, ctx, rc, parts[1]);

  if (rc.demo && path === "/demo/start" && method === "POST") return await openDemoDesk(request, ctx, rc); // demo

  // Owner pages
  if (parts[0] === "desk") {
    const blocked = await ownerGate(request, ctx, rc);
    if (blocked) return blocked;

    if (path === "/desk" && method === "GET") return await desk(ctx, rc);
    if (path === "/desk/new" && method === "GET") return await newDocumentForm(ctx, rc);
    if (path === "/desk/documents" && method === "POST") return await createDocument(request, ctx, rc);
    if (path === "/desk/clients" && method === "GET") return await clients(ctx, rc);
    if (path === "/desk/clients" && method === "POST") return await addClient(request, ctx, rc);
    if (parts[1] === "documents" && parts.length === 3) {
      if (method === "GET") return await showDocument(ctx, rc, parts[2]);
      if (method === "POST") return await saveDocument(request, ctx, rc, parts[2]);
    }
    if (parts[1] === "documents" && parts.length === 4) {
      if (parts[3] === "edit" && method === "GET") return await editDocumentForm(ctx, rc, parts[2]);
      if (parts[3] === "status" && method === "POST") return await changeStatus(request, ctx, rc, parts[2]);
      if (parts[3] === "convert" && method === "POST") return await convert(request, ctx, rc, parts[2]);
    }
    if (parts[1] === "clients" && parts.length === 3) {
      if (method === "GET") return await showClient(ctx, rc, parts[2]);
      if (method === "POST") return await saveClient(request, ctx, rc, parts[2]);
    }
  }

  return notFound(rc);
}

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
    try {
      return await route(request, ctx);
    } catch (error) {
      if (error instanceof Response) return error; // readForm throws ready-made responses
      await ctx.log.error("request failed", { path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) });
      const rc = requestContext(request);
      return html(views.messagePage(rc, { title: "Something went wrong", message: "Please try again in a moment." }), 500);
    }
  },

  async job(event, ctx) {
    if (event.name === "clear-demo") await demo.clearDemo(event, ctx); // demo
  }
};

export default app;

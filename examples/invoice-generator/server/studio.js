// Business details printed on the public page, quotes, and invoices.
// Change these first when you adapt the example for a real business.
// Kern & Frame is a fictional studio; the address and email are placeholders.

export const STUDIO = {
  name: "Kern & Frame",
  tagline: "Design and photography studio",
  address: ["212 Mercer Lane, Studio 4", "Portland, OR 97214"],
  email: "hello@example.com",
  website: "kernandframe.example.com",

  // Money is stored in whole cents and formatted with this currency and locale.
  currency: "USD",
  locale: "en-US",

  // The studio's time zone decides what "today" is: new document dates, the
  // date on the desk, and when an unpaid invoice counts as overdue.
  timeZone: "America/Los_Angeles",

  // Defaults for new documents. The owner can change each one per document.
  defaultTaxPercent: 0,
  quoteValidDays: 30,
  paymentTermsDays: 14,
  quoteNotes: "Includes two rounds of revisions. A 50% deposit books the dates once the quote is accepted.",
  invoiceNotes: "Payment by bank transfer within 14 days. Please use the invoice number as the payment reference.",

  // Document numbers start after these, so a new studio can continue its old numbering.
  numbering: {
    quote: { prefix: "Q-", start: 140 },
    invoice: { prefix: "INV-", start: 230 }
  },

  // Shown on the public page and offered in the quote request form.
  services: [
    { id: "identity", name: "Brand identity", detail: "Logo, type, color, and a short guide", from_cents: 480000 },
    { id: "photography", name: "Product and editorial photography", detail: "Studio or on location, per day", from_cents: 140000 },
    { id: "packaging", name: "Packaging design", detail: "Labels, boxes, and print-ready files", from_cents: 320000 },
    { id: "web", name: "Website design", detail: "Design for a small marketing site", from_cents: 650000 }
  ]
};

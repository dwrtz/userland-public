// Small progressive enhancements. Every page works without this file:
// forms post to the server, and the server does all the money math.

function parseNumber(value) {
  const text = String(value ?? "").trim().replace(/^\p{Sc}\s*/u, "").replace(/,/g, "");
  if (text === "" || !/^\d*(\.\d*)?$/.test(text)) return null;
  return Number(text);
}

// The same whole-number math as lineCents and taxCents in server/store.js,
// so the preview matches the saved document to the cent.
function lineCents(quantity, unitCents) {
  const hundredths = Math.round(quantity * 100);
  return Math.floor((hundredths * unitCents + 50) / 100);
}

function taxCents(subtotalCents, percent) {
  const thousandths = BigInt(Math.round(percent * 1000));
  return Number((BigInt(subtotalCents) * thousandths + 50000n) / 100000n);
}

// Send each form once: a double click on "Create invoice from quote" or
// "Send request" would otherwise post it twice. (The server copes either way.)
for (const form of document.querySelectorAll('form[method="post"]')) {
  form.addEventListener("submit", (event) => {
    const submitter = event.submitter;
    if (submitter?.name === "intent") return; // "Add a line" without JavaScript
    if (form.dataset.sending) {
      event.preventDefault();
      return;
    }
    form.dataset.sending = "true";
  });
}
window.addEventListener("pageshow", () => {
  for (const form of document.querySelectorAll("form[data-sending]")) delete form.dataset.sending;
});

// Print buttons on quotes and invoices.
for (const button of document.querySelectorAll("[data-print]")) {
  button.addEventListener("click", () => window.print());
}

// Copy the private client link.
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const input = document.querySelector(button.dataset.copy);
    const status = button.closest(".panel-block")?.querySelector(".copy-status");
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
      if (status) status.textContent = "Link copied.";
    } catch {
      input.select();
      if (status) status.textContent = "Press Ctrl+C or Cmd+C to copy.";
    }
  });
}

// Line items: live amounts and totals, and adding rows without a page reload.
const form = document.querySelector("[data-line-form]");
if (form) {
  const locale = form.dataset.locale || "en-US";
  const amountFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyFormat = new Intl.NumberFormat(locale, { style: "currency", currency: form.dataset.currency || "USD" });
  const body = form.querySelector("[data-line-body]");
  const taxInput = form.querySelector("#tax_percent");
  const addButton = form.querySelector("[data-add-line]");
  const output = (selector) => form.querySelector(selector);

  const update = () => {
    let subtotal = 0;
    for (const row of body.querySelectorAll("tr")) {
      const description = row.querySelector('[name="item_description"]').value.trim();
      const quantityText = row.querySelector('[name="item_quantity"]').value;
      const quantity = quantityText.trim() === "" ? 1 : parseNumber(quantityText);
      const rate = parseNumber(row.querySelector('[name="item_rate"]').value);
      const cell = row.querySelector("[data-line-amount]");
      if (quantity !== null && rate !== null && (description || rate > 0)) {
        const cents = lineCents(quantity, Math.round(rate * 100));
        subtotal += cents;
        cell.textContent = amountFormat.format(cents / 100);
        delete cell.dataset.empty;
      } else {
        cell.textContent = amountFormat.format(0);
        cell.dataset.empty = "";
      }
    }
    const taxPercent = parseNumber(taxInput?.value) ?? 0;
    const tax = taxCents(subtotal, taxPercent);
    output("[data-subtotal]").textContent = amountFormat.format(subtotal / 100);
    output("[data-tax]").textContent = amountFormat.format(tax / 100);
    output("[data-total]").textContent = moneyFormat.format((subtotal + tax) / 100);
  };

  form.addEventListener("input", update);
  update();

  addButton?.addEventListener("click", (event) => {
    event.preventDefault();
    const rows = body.querySelectorAll("tr");
    const max = Number(addButton.dataset.maxLines ?? 20);
    if (rows.length >= max) return;
    const index = rows.length;
    const row = rows[rows.length - 1].cloneNode(true);
    for (const input of row.querySelectorAll("input")) {
      const field = input.name.replace("item_", "");
      input.id = `item-${field}-${index}`;
      input.value = field === "quantity" ? "1" : "";
      input.removeAttribute("aria-invalid");
    }
    for (const label of row.querySelectorAll("label")) {
      const field = label.htmlFor.split("-")[1];
      label.htmlFor = `item-${field}-${index}`;
      label.textContent = label.textContent.replace(/Line \d+/, `Line ${index + 1}`);
    }
    const amount = row.querySelector("[data-line-amount]");
    amount.textContent = amountFormat.format(0);
    amount.dataset.empty = "";
    body.append(row);
    row.querySelector('[name="item_description"]').focus();
    if (index + 1 >= max) addButton.disabled = true;
  });
}

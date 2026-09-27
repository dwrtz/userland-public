const slotsEl = document.querySelector("#slots");
const form = document.querySelector("#book");
const formTitle = document.querySelector("#book-title");
const message = document.querySelector("#book-message");

const problems = {
  slot_unavailable: "Sorry, that time was just taken. Please pick another.",
  name_required: "Please enter your name.",
  name_too_long: "Please shorten your name to 120 characters or fewer.",
  invalid_email: "Please enter an email address like name@example.com.",
  too_many_bookings: "You've already booked twice today. Please get in touch if you need more times.",
  busy: "Lots of people are booking right now. Please try again in an hour."
};

function when(startsAt) {
  return new Date(startsAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

async function loadSlots() {
  const response = await fetch("/api/slots");
  if (!response.ok) {
    slotsEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: "Open times could not be loaded. Please refresh the page." }));
    return;
  }
  const { slots } = await response.json();
  if (slots.length === 0) {
    slotsEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: "No open times right now. Please check back soon." }));
    return;
  }
  slotsEl.replaceChildren(
    ...slots.map((slot) => {
      const article = document.createElement("article");
      const label = document.createElement("p");
      label.textContent = `${slot.title}: ${when(slot.starts_at)}`;
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "secondary";
      pick.textContent = "Book";
      pick.addEventListener("click", () => {
        form.elements.slot_id.value = slot.id;
        formTitle.textContent = label.textContent;
        message.textContent = "";
        form.hidden = false;
        form.elements.name.focus();
      });
      article.append(label, pick);
      return article;
    })
  );
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  message.textContent = "Booking...";
  const response = await fetch("/api/bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    message.textContent = problems[body.error] ?? "Something went wrong. Please try again.";
    if (response.status === 409) await loadSlots();
    return;
  }
  form.reset();
  form.hidden = true;
  slotsEl.before(Object.assign(document.createElement("p"), { className: "done", textContent: `You're booked: ${formTitle.textContent}.` }));
  await loadSlots();
});

await loadSlots();

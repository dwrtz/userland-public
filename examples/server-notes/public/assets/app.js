const form = document.querySelector("#new-note");
const formMessage = document.querySelector("#form-message");
const notesEl = document.querySelector("#notes");
const moreButton = document.querySelector("#more-notes");
let cursor = null;

const problems = {
  title_required: "Please give your note a title.",
  note_too_long: "Please keep the title under 200 characters and the note under 2,000.",
  too_many_notes: "Lots of notes were added in the last hour. Please try again later.",
  board_full: "The board is full right now. Please try again in a few days."
};

function noteCard(note) {
  const article = document.createElement("article");
  const title = document.createElement("h2");
  const body = document.createElement("p");
  title.textContent = note.title;
  body.textContent = note.body;
  article.append(title, body);
  return article;
}

// Loads one page of notes. The server returns a `cursor` when there are more;
// "Show more notes" passes it back.
async function loadNotes(reset = false) {
  if (reset) cursor = null;
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/notes?${params}`);
  if (!response.ok) {
    notesEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: "The notes could not be loaded. Please refresh the page." }));
    return;
  }
  const body = await response.json();
  const cards = body.notes.map(noteCard);
  if (reset) notesEl.replaceChildren(...cards);
  else notesEl.append(...cards);
  if (notesEl.children.length === 0) notesEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: "No notes yet." }));
  cursor = body.cursor ?? null;
  moreButton.hidden = !cursor;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  formMessage.textContent = "Saving...";
  const response = await fetch("/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: data.get("title"), body: data.get("body"), website: data.get("website") })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    formMessage.textContent = problems[body.error] ?? "Something went wrong. Please try again.";
    return;
  }
  form.reset();
  formMessage.textContent = "Note added.";
  await loadNotes(true);
});

moreButton.addEventListener("click", () => loadNotes());
await loadNotes(true);

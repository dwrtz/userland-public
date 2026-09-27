const form = document.querySelector("#ask");
const answerEl = document.querySelector("#answer");

const problems = {
  prompt_required: "Please type a question first.",
  prompt_too_long: "Please shorten your question to 4,000 characters or fewer.",
  model_unavailable: "The AI model isn't available right now. Please try again later."
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  answerEl.textContent = "Thinking...";
  try {
    // Same-origin JSON request: the only kind /api/run accepts.
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: new FormData(form).get("prompt") })
    });
    const body = await response.json().catch(() => ({}));
    answerEl.textContent = response.ok ? body.answer : problems[body.error] ?? "Something went wrong. Please try again.";
  } catch {
    answerEl.textContent = "Something went wrong. Please check your connection and try again.";
  } finally {
    button.disabled = false;
  }
});

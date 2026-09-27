// Optional: shows a "Copy link" button when the browser can copy to the clipboard.
// Everything on the page works without this file.
for (const button of document.querySelectorAll("[data-copy]")) {
  const input = document.querySelector(button.getAttribute("data-copy"));
  if (!input || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      button.textContent = "Copied";
    } catch {
      input.select();
      button.textContent = "Press Ctrl+C to copy";
    }
    setTimeout(() => {
      button.textContent = "Copy link";
    }, 2400);
  });
}

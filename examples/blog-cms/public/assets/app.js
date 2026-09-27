const postsEl = document.querySelector("#posts");
const morePostsButton = document.querySelector("#more-posts");
const accountEl = document.querySelector("#account");
const adminEl = document.querySelector("#admin");
const editor = document.querySelector("#editor");
const editorMessage = document.querySelector("#editor-message");
const draftsEl = document.querySelector("#drafts");
const moreDraftsButton = document.querySelector("#more-drafts");

const loginHref = `/_userland/auth/login?return_to=${encodeURIComponent("/")}`;

// Turns an error response into a sentence for the person using the page.
function problem(response) {
  if (response.status === 401) return "Your sign-in has ended. Please sign in again.";
  if (response.status === 403) return "Only blog admins can do that.";
  if (response.status === 413) return "That post is too long.";
  return "Something went wrong. Please try again.";
}

function link(href, text) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = text;
  return anchor;
}

// Loads one page of posts and appends it. The server returns a `cursor` when
// there are more; the "Show more" button passes it back.
function pagedList({ status, listEl, moreButton, render, emptyText }) {
  let cursor = null;
  async function load(reset = false) {
    if (reset) cursor = null;
    const params = new URLSearchParams({ status });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/posts?${params}`);
    if (!response.ok) {
      listEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: problem(response) }));
      moreButton.hidden = true;
      return;
    }
    const body = await response.json();
    const items = body.posts.map(render);
    if (reset) listEl.replaceChildren(...items);
    else listEl.append(...items);
    if (listEl.children.length === 0) listEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: emptyText }));
    cursor = body.cursor ?? null;
    moreButton.hidden = !cursor;
  }
  moreButton.addEventListener("click", () => load());
  return load;
}

const loadPosts = pagedList({
  status: "published",
  listEl: postsEl,
  moreButton: morePostsButton,
  emptyText: "No posts yet.",
  render(post) {
    const article = document.createElement("article");
    article.append(link(`/posts/${encodeURIComponent(post.id)}`, post.title));
    return article;
  }
});

const loadDrafts = pagedList({
  status: "draft",
  listEl: draftsEl,
  moreButton: moreDraftsButton,
  emptyText: "No drafts.",
  render(post) {
    const article = document.createElement("article");
    const title = document.createElement("p");
    title.textContent = post.title;
    const publish = document.createElement("button");
    publish.type = "button";
    publish.textContent = "Publish";
    publish.addEventListener("click", async () => {
      publish.disabled = true;
      const response = await fetch(`/api/posts/${encodeURIComponent(post.id)}/publish`, { method: "POST" });
      if (!response.ok) {
        publish.disabled = false;
        title.textContent = `${post.title}: ${problem(response)}`;
        return;
      }
      await Promise.all([loadPosts(true), loadDrafts(true)]);
    });
    article.append(title, publish);
    return article;
  }
});

async function showAccount() {
  const response = await fetch("/_userland/auth/session", { cache: "no-store" });
  const { user } = response.ok ? await response.json() : { user: null };
  if (!user) {
    accountEl.replaceChildren("Blog admins can ", link(loginHref, "sign in"), " to write posts.");
    return false;
  }
  const isAdmin = Array.isArray(user.roles) && user.roles.includes("admin");
  accountEl.replaceChildren(
    `Signed in as ${user.email}. `,
    isAdmin ? "" : "Your account can read posts but not write them. ",
    link(`/_userland/auth/logout?return_to=${encodeURIComponent("/")}`, "Sign out")
  );
  return isAdmin;
}

editor.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = event.submitter?.value === "published" ? "published" : "draft";
  const form = new FormData(editor);
  editorMessage.textContent = "Saving...";
  const response = await fetch("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: form.get("title"),
      body: form.get("body"),
      image_url: form.get("image_url"),
      status
    })
  });
  if (!response.ok) {
    editorMessage.textContent = problem(response);
    return;
  }
  editor.reset();
  editorMessage.textContent = status === "published" ? "Published." : "Saved as a draft.";
  await Promise.all([loadPosts(true), loadDrafts(true)]);
});

await loadPosts(true);
if (await showAccount()) {
  adminEl.hidden = false;
  await loadDrafts(true);
}

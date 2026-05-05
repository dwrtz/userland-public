const postsEl = document.querySelector("#posts");
const editor = document.querySelector("#editor");

async function loadPosts() {
  const response = await fetch("/api/posts");
  const body = await response.json();
  postsEl.replaceChildren(
    ...body.posts.map((post) => {
      const article = document.createElement("article");
      const link = document.createElement("a");
      link.href = `/posts/${post.id}`;
      link.textContent = post.title;
      article.append(link);
      return article;
    })
  );
}

editor.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(editor);
  const response = await fetch("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: form.get("title"),
      body: form.get("body"),
      image_url: form.get("image_url"),
      status: "draft"
    })
  });
  if (response.ok) {
    editor.reset();
    await loadPosts();
  }
});

await loadPosts();

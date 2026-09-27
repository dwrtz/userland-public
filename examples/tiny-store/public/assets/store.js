const productsEl = document.querySelector("#products");
const moreButton = document.querySelector("#more-products");
let cursor = null;

// Loads one page of products. The server returns a `cursor` when there are
// more; "Show more products" passes it back.
async function loadProducts() {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/products?${params}`);
  if (!response.ok) {
    productsEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: "The products could not be loaded. Please refresh the page." }));
    moreButton.hidden = true;
    return;
  }
  const body = await response.json();
  productsEl.append(
    ...body.products.map((product) => {
      const article = document.createElement("article");
      const title = document.createElement("h2");
      const price = document.createElement("p");
      title.textContent = product.name;
      price.textContent = `${product.currency} ${(product.price_cents / 100).toFixed(2)}${product.in_stock ? "" : " · Sold out"}`;
      article.append(title, price);
      return article;
    })
  );
  if (productsEl.children.length === 0) productsEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: "No products yet." }));
  cursor = body.cursor ?? null;
  moreButton.hidden = !cursor;
}

moreButton.addEventListener("click", loadProducts);
await loadProducts();

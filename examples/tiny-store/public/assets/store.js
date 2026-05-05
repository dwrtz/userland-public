const productsEl = document.querySelector("#products");

async function loadProducts() {
  const response = await fetch("/api/products");
  const body = await response.json();
  productsEl.replaceChildren(
    ...body.products.map((product) => {
      const article = document.createElement("article");
      const title = document.createElement("h2");
      const price = document.createElement("p");
      title.textContent = product.name;
      price.textContent = `${product.currency} ${(product.price_cents / 100).toFixed(2)}`;
      article.append(title, price);
      return article;
    })
  );
}

await loadProducts();

const PRICE_CHARTING_BASE = "https://www.pricecharting.com";

function hasCredentials() {
  return Boolean(process.env.PRICECHARTING_TOKEN && !String(process.env.PRICECHARTING_TOKEN).includes("your-"));
}

function cents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 100 : 0;
}

function confidenceScore(query, product) {
  const title = `${product["product-name"] || ""} ${product["console-name"] || ""}`.toLowerCase();
  const tokens = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(token => token.length > 2);
  const hits = tokens.filter(token => title.includes(token)).length;
  return Math.max(45, Math.min(92, 58 + hits * 7));
}

function normalizeProduct(product, query) {
  const prices = {
    loose: cents(product["loose-price"]),
    cib: cents(product["cib-price"]),
    new: cents(product["new-price"]),
    graded: cents(product["graded-price"]),
    boxOnly: cents(product["box-only-price"]),
    manualOnly: cents(product["manual-only-price"]),
    retailLooseBuy: cents(product["retail-loose-buy"]),
    retailLooseSell: cents(product["retail-loose-sell"]),
    retailCibBuy: cents(product["retail-cib-buy"]),
    retailCibSell: cents(product["retail-cib-sell"]),
    retailNewBuy: cents(product["retail-new-buy"]),
    retailNewSell: cents(product["retail-new-sell"])
  };

  return {
    id: product.id || "",
    title: product["product-name"] || query,
    categoryName: product["console-name"] || "",
    source: "PriceCharting API",
    url: `${PRICE_CHARTING_BASE}/search-products?q=${encodeURIComponent(product["product-name"] || query)}`,
    confidence: confidenceScore(query, product),
    releaseDate: product["release-date"] || "",
    prices,
    raw: product
  };
}

async function lookupPriceCharting({ item }) {
  if (!hasCredentials()) {
    throw new Error("Missing PriceCharting token");
  }

  const query = String(item || "").trim();
  if (!query) throw new Error("Missing PriceCharting query");

  const params = new URLSearchParams({
    t: process.env.PRICECHARTING_TOKEN,
    q: query
  });

  const response = await fetch(`${PRICE_CHARTING_BASE}/api/product?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });

  const data = await response.json();
  if (!response.ok || data.status === "error") {
    throw new Error(data["error-message"] || `PriceCharting lookup failed: ${response.status}`);
  }

  if (!data.id && !data["product-name"]) {
    throw new Error("PriceCharting returned no product match");
  }

  return normalizeProduct(data, query);
}

module.exports = {
  hasCredentials,
  lookupPriceCharting
};

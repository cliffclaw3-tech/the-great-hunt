function barcodeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function validBarcode(value) {
  const digits = barcodeDigits(value);
  return digits.length >= 7 && digits.length <= 14 ? digits : "";
}

function normalizePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function productFromUpcItemDb(item) {
  if (!item) return null;
  const title = cleanText(item.title || item.description);
  if (!title) return null;

  return {
    source: "UPCitemdb",
    title,
    brand: cleanText(item.brand),
    barcode: cleanText(item.ean || item.upc),
    category: cleanText(item.category),
    image: Array.isArray(item.images) ? item.images[0] || "" : "",
    lowestPrice: normalizePrice(item.lowest_recorded_price),
    highestPrice: normalizePrice(item.highest_recorded_price),
    offers: Array.isArray(item.offers)
      ? item.offers.slice(0, 5).map(offer => ({
        title: cleanText(offer.title),
        merchant: cleanText(offer.merchant || offer.domain),
        price: normalizePrice(offer.price),
        url: cleanText(offer.link)
      }))
      : []
  };
}

async function lookupUpcItemDb(barcode) {
  const userKey = process.env.UPCITEMDB_USER_KEY && !process.env.UPCITEMDB_USER_KEY.includes("your-")
    ? process.env.UPCITEMDB_USER_KEY
    : "";
  const endpoint = userKey
    ? "https://api.upcitemdb.com/prod/v1/lookup"
    : "https://api.upcitemdb.com/prod/trial/lookup";
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  if (userKey) {
    headers.user_key = userKey;
    headers.key_type = "3scale";
  }

  const response = await fetch(`${endpoint}?upc=${encodeURIComponent(barcode)}`, {
    headers,
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`UPCitemdb returned ${response.status}`);
  const data = await response.json();
  return productFromUpcItemDb(data.items?.[0]);
}

function productFromBarcodeLookup(item) {
  if (!item) return null;
  const title = cleanText(item.title || item.product_name);
  if (!title) return null;

  return {
    source: "Barcode Lookup",
    title,
    brand: cleanText(item.brand || item.manufacturer),
    barcode: cleanText(item.barcode_number),
    category: cleanText(item.category),
    image: Array.isArray(item.images) ? item.images[0] || "" : "",
    lowestPrice: normalizePrice(item.lowest_recorded_price),
    highestPrice: normalizePrice(item.highest_recorded_price),
    offers: Array.isArray(item.stores)
      ? item.stores.slice(0, 5).map(store => ({
        title,
        merchant: cleanText(store.name || store.store_name),
        price: normalizePrice(store.price),
        url: cleanText(store.link)
      }))
      : []
  };
}

async function lookupBarcodeLookup(barcode) {
  const key = process.env.BARCODE_LOOKUP_API_KEY && !process.env.BARCODE_LOOKUP_API_KEY.includes("your-")
    ? process.env.BARCODE_LOOKUP_API_KEY
    : "";
  if (!key) return null;

  const url = new URL("https://api.barcodelookup.com/v3/products");
  url.searchParams.set("barcode", barcode);
  url.searchParams.set("key", key);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Barcode Lookup returned ${response.status}`);
  const data = await response.json();
  return productFromBarcodeLookup(data.products?.[0]);
}

function productFromOpenFacts(data, source) {
  const product = data?.product;
  if (!product) return null;
  const title = cleanText(product.product_name || product.generic_name || product.abbreviated_product_name);
  if (!title) return null;

  return {
    source,
    title,
    brand: cleanText(product.brands),
    barcode: cleanText(product.code || data.code),
    category: cleanText(product.categories),
    image: cleanText(product.image_front_url || product.image_url),
    lowestPrice: 0,
    highestPrice: 0,
    offers: []
  };
}

async function lookupOpenFacts(barcode, host, source) {
  const response = await fetch(`https://${host}/api/v2/product/${encodeURIComponent(barcode)}.json`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "TheGreatHunt/0.1 (https://thegreathunt.io)"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`${source} returned ${response.status}`);
  const data = await response.json();
  if (Number(data.status || 0) !== 1) return null;
  return productFromOpenFacts(data, source);
}

function mergedProduct(products) {
  const usable = products.filter(Boolean);
  if (!usable.length) return null;
  const primary = usable[0];
  const offers = usable.flatMap(product => product.offers || []).slice(0, 8);
  const sources = usable.map(product => product.source).filter(Boolean);
  return {
    ...primary,
    offers,
    sources,
    source: sources.join(" + ")
  };
}

async function lookupProductByBarcode(value) {
  const barcode = validBarcode(value);
  if (!barcode) return null;

  const lookups = [
    lookupUpcItemDb(barcode),
    lookupBarcodeLookup(barcode),
    lookupOpenFacts(barcode, "world.openproductsfacts.org", "Open Products Facts"),
    lookupOpenFacts(barcode, "world.openfoodfacts.org", "Open Food Facts")
  ];
  const results = await Promise.allSettled(lookups);
  const products = results
    .filter(result => result.status === "fulfilled")
    .map(result => result.value)
    .filter(Boolean);
  return mergedProduct(products);
}

function hasProductLookupConfig() {
  return {
    upcItemDb: true,
    barcodeLookup: Boolean(process.env.BARCODE_LOOKUP_API_KEY && !process.env.BARCODE_LOOKUP_API_KEY.includes("your-")),
    openFacts: true
  };
}

module.exports = {
  barcodeDigits,
  lookupProductByBarcode,
  hasProductLookupConfig
};

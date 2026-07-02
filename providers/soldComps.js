const fs = require("node:fs/promises");
const path = require("node:path");

const SOLD_COMPS_API_BASE = process.env.SOLD_COMPS_API_BASE || "https://api.sold-comps.com";
const cachePath = path.join(__dirname, "..", "data", "soldcomps-cache.json");

function hasCredentials() {
  return Boolean(process.env.SOLD_COMPS_API_KEY && !String(process.env.SOLD_COMPS_API_KEY).includes("your-"));
}

function buildSearchQuery({ item, category }) {
  return String(item || category || "").trim();
}

function cacheKey({ query, category, limit }) {
  return `${category || "any"}::${query.toLowerCase()}::${Math.max(1, Math.min(240, limit))}`;
}

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeCache(cache) {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // Cache writes should never block live valuation.
  }
}

async function cachedResult(key) {
  const cache = await readCache();
  return cache[key]?.result || null;
}

async function saveCachedResult(key, result) {
  const cache = await readCache();
  cache[key] = {
    cachedAt: new Date().toISOString(),
    result
  };
  const entries = Object.entries(cache).slice(-300);
  await writeCache(Object.fromEntries(entries));
}

function categoryIdFor(category) {
  const map = {
    Watches: "281",
    Jewelry: "281",
    "Sports cards": "64482",
    "Sports memorabilia": "64482",
    "Comic books": "1",
    Coins: "1",
    Stamps: "1",
    "Vintage audio": "293",
    Instruments: "619",
    "Retail arbitrage": "0",
    Tools: "11700",
    "Video games": "139973"
  };

  return map[category] || "0";
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function hasTokenBoundary(text, token) {
  const normalizedToken = String(token || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalizedToken) return false;
  const pattern = normalizedToken
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^a-z0-9]+");
  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "i").test(String(text || ""));
}

function filterReason(title, queryTokens) {
  const lower = String(title || "").toLowerCase();
  const blockedPatterns = [
    [/for parts|parts only|\bparts\b|broken|not working|repair|spares\/repairs|needs service|sold as is|\bas is\b/, "Parts or repair listing"],
    [/\b(chipped|big chip|chip\b|crack|cracked|damaged|broken)\b/, "Damaged listing"],
    [/reproduction|replica|fake|counterfeit|facsimile/, "Reproduction or authenticity risk"],
    [/\bbundle\b|lot of|job lot|\b\d+\s*(?:x\s*)?(?:coin|coins|card|cards|piece|pieces)\b|\b(?:coin|card|piece)\s*lot\b|\blot\s*(?:of\s*)?\d+\b|\b\d+\s*lot\b|\brolls?\b|\b\d+x\s*rolls?\b|\bpds\b.*\bmint marks\b/, "Bundle or lot listing"],
    [/empty box|box only|manual only/, "Packaging or manual only"],
    [/^for .*?(strap|bracelet|clasp|band)|replacement|refill|converter|cartridge|case\s*back|caseback|watch case|case part|case only|watch bracelet|\b\d{1,2}mm\s+bracelet\b|mesh strap|rubber\s+(?:band|strap)|watch\s+(?:band|strap)|watch clasp|\bclasp\b|pusher springs?|dial only|\bdial\s*(?:for|part|replacement)\b|hands only|\bhands\s*(?:for|part|replacement)\b|watch crown|crown only|bracelet link|servicing|pressure test/, "Component or refill"],
    [/guitar strings?|\bnut\b|bridge pins?|guitar picks?|\bpicks?\b|truss rod tool|fingerboard|guitar case|hardshell case|wood case|strap button|guitar strap|strap lock/, "Instrument accessory or part"],
    [/body only|camera body|body cap|motor drive|battery grip|manual only|case only|lens cap|filter only|filter kit|lens accessory|accessory kit|adapter/, "Camera accessory or body-only listing"],
    [/rebuild set|recap kit|capacitor kit|resistors?|emitter resistor|transistors?|parting out|tuning board|phono board|preamp board|p700 board|p400 board|potentiometer|switch assembly/, "Audio repair part or kit"]
  ];

  const matchedPattern = blockedPatterns.find(([pattern]) => pattern.test(lower));
  if (matchedPattern) {
    return matchedPattern[1];
  }

  const tokenHits = queryTokens.filter(token => hasTokenBoundary(lower, token));
  return queryTokens.length > 0 && tokenHits.length === 0 ? "Missing item keywords" : "";
}

function confidenceScore({ query, item }) {
  const title = String(item.title || "").toLowerCase();
  const queryTokens = tokenize(query);
  const exactPhrase = String(query || "").trim().toLowerCase();
  let score = 50;

  if (exactPhrase && hasTokenBoundary(title, exactPhrase)) score += 25;
  score += Math.min(24, queryTokens.filter(token => hasTokenBoundary(title, token)).length * 5);

  const refLikeTokens = queryTokens.filter(token => /\d/.test(token) || /[a-z]+\d|\d+[a-z]+/i.test(token));
  score += Math.min(18, refLikeTokens.filter(token => hasTokenBoundary(title, token)).length * 9);

  if (item.epid) score += 5;
  if (item.sellerFeedbackScore && Number(item.sellerFeedbackScore) > 100) score += 2;

  return Math.max(1, Math.min(99, score));
}

function parsePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSoldItem(item, query) {
  const price = parsePrice(item.soldPrice);
  const shipping = parsePrice(item.shippingPrice) || 0;
  const total = parsePrice(item.totalPrice);
  const currency = item.currency || item.priceCurrency || item.soldPriceCurrency || "USD";

  return {
    title: item.title || "Untitled sold comp",
    price,
    shipping,
    total: total || (price !== null ? price + shipping : null),
    condition: item.itemCondition || item.condition || "Sold",
    source: "SoldComps sold API",
    url: item.url || null,
    image: item.imageUrl || item.image || null,
    soldDate: item.endedAt || null,
    confidence: confidenceScore({ query, item }),
    currency,
    shippingCurrency: currency,
    buyingOptions: ["SOLD"],
    epid: item.epid || null,
    sellerFeedbackScore: item.sellerFeedbackScore || null,
    sellerPositivePercent: item.sellerPositivePercent || null
  };
}

async function searchSoldComps({ item, category, limit = 24 }) {
  if (!hasCredentials()) {
    throw new Error("Missing SoldComps API key");
  }

  const query = buildSearchQuery({ item, category });
  const key = cacheKey({ query, category, limit });
  const params = new URLSearchParams({
    keyword: query,
    count: String(Math.max(1, Math.min(240, limit))),
    page: "1",
    ebaySite: "ebay.com",
    sortOrder: "endedRecently",
    itemCondition: "any",
    categoryId: categoryIdFor(category)
  });

  const response = await fetch(`${SOLD_COMPS_API_BASE}/v1/scrape?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${process.env.SOLD_COMPS_API_KEY}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      const cached = await cachedResult(key);
      if (cached) {
        return {
          ...cached,
          source: "SoldComps sold API cache",
          cached: true,
          quotaWarning: errorText
        };
      }
    }
    throw new Error(`SoldComps search failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];
  const queryTokens = tokenize(query);
  const rejected = [];

  const normalized = items
    .map(listing => normalizeSoldItem(listing, query))
    .filter(listing => {
      const reason = filterReason(listing.title, queryTokens);
      const currencyMismatch = listing.currency !== "USD" || listing.shippingCurrency !== "USD";
      if (reason || listing.price === null || !listing.url || currencyMismatch) {
        rejected.push({ ...listing, reason: reason || (currencyMismatch ? "Non-USD sold comp" : "Missing sale price or URL") });
        return false;
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence || b.total - a.total);

  const result = {
    query,
    total: data.totalItems || normalized.length,
    results: normalized,
    rejected,
    hasNextPage: Boolean(data.hasNextPage),
    page: Number(data.page || 1)
  };
  await saveCachedResult(key, result);
  return result;
}

module.exports = {
  hasCredentials,
  searchSoldComps
};

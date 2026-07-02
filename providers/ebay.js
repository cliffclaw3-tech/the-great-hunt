const EBAY_ENV = (process.env.EBAY_ENV || "sandbox").toLowerCase();

const API_BASE = EBAY_ENV === "production"
  ? "https://api.ebay.com"
  : "https://api.sandbox.ebay.com";

const TOKEN_BASE = EBAY_ENV === "production"
  ? "https://api.ebay.com"
  : "https://api.sandbox.ebay.com";

const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const INSIGHTS_SCOPE = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

const tokenCache = new Map();

function hasCredentials() {
  return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
}

async function getAccessToken(scope = BROWSE_SCOPE) {
  if (!hasCredentials()) {
    throw new Error("Missing eBay credentials");
  }

  const now = Date.now();
  const cached = tokenCache.get(scope);
  if (cached?.accessToken && cached.expiresAt > now + 60_000) {
    return cached.accessToken;
  }

  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope
  });

  const response = await fetch(`${TOKEN_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`eBay token request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  tokenCache.set(scope, {
    accessToken: data.access_token,
    expiresAt: now + ((data.expires_in || 7200) * 1000)
  });

  return data.access_token;
}

function buildSearchQuery({ item, category }) {
  return String(item || category || "").trim();
}

function categoryHints(category) {
  const map = {
    Watches: ["watch", "wristwatch", "reference"],
    Books: ["book", "edition", "dust jacket", "printing", "hardcover"],
    Pens: ["pen", "fountain pen", "rollerball", "nib"],
    "Vintage audio": ["receiver", "amplifier", "stereo", "turntable", "speaker"],
    Knives: ["knife", "folding knife", "fixed blade"],
    Instruments: ["guitar", "amp", "instrument", "pedal", "synth"],
    "Retail arbitrage": ["new", "sealed", "sku", "discontinued"],
    Tools: ["ratchet", "wrench", "socket", "drive", "craftsman", "snap-on", "matco"],
    "Sports cards": ["card", "rookie", "psa", "sgc", "bgs", "topps", "panini", "bowman", "prizm"],
    Lighting: ["lamp", "lighting", "shade", "sconce", "chandelier", "table lamp", "floor lamp"],
    Furniture: ["table", "chair", "dresser", "desk", "cabinet", "teak", "walnut", "mid century"],
    Toys: ["toy", "lego", "set", "doll", "figure", "hot wheels", "funko", "complete"],
    "Video games": ["nintendo", "game", "cartridge", "disc", "cib", "complete", "console"]
  };

  return map[category] || [];
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTokenBoundary(text, token) {
  const normalizedToken = String(token || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalizedToken) return false;
  const pattern = normalizedToken
    .split(/\s+/)
    .map(escapeRegExp)
    .join("[^a-z0-9]+");
  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "i").test(String(text || ""));
}

function filterReason(title, queryTokens) {
  const lower = String(title || "").toLowerCase();
  const blockedPatterns = [
    [/for parts|parts only|\bparts\b|broken|not working|repair|spares\/repairs|needs service|sold as is|\bas is\b|partial(?:ly)? tested|partial test|powers on only|works\/read|\(\s*read\s*\)|\bread description\b|pieces come apart|comes apart/, "Parts, repair, or disclosed-issue listing"],
    [/\b(chipped|big chip|chip\b|crack|cracked|damaged|broken)\b/, "Damaged listing"],
    [/reproduction|replica|fake|counterfeit|facsimile/, "Reproduction or authenticity risk"],
    [/bundle|lot of|job lot/, "Bundle or lot listing"],
    [/print ad|\bad\b/, "Ad or paper ephemera"],
    [/replacement|filler cup|diaphragm|refill|converter|cartridge|pellet|bushing|\bjewel\b|\bcup\b|\bcups\b|nib unit|\bfeed\b/, "Component or refill"],
    [/^for .*?(strap|bracelet|clasp|band)|strap for|hanging strap|magnetic hanging strap|^(?:meter\s+)?leads?\b|test probe set|probes?\s+fit|leads?\s+(?:for|fit)|cap only|nib only|case\s*back|caseback|watch case|case part|case only|watch bracelet|\b\d{1,2}mm\s+bracelet\b|mesh strap|rubber\s+(?:band|strap)|watch\s+(?:band|strap)|dial only|\bdial\s*(?:for|part|replacement)\b|hands only|\bhands\s*(?:for|part|replacement)\b|watch crown|crown only|bracelet link|servicing|pressure test/, "Item part, not full item"],
    [/no pen|without pen|missing pen|no ear\s*pads?|without ear\s*pads?|missing ear\s*pads?|charging cradle|cradle only|headphones?\s*-\s*case\s*-/, "Incomplete or accessory listing"],
    [/handle sleeve|\bsleeve\b|protector|pot holder/, "Accessory listing"]
  ];

  const matchedPattern = blockedPatterns.find(([pattern]) => pattern.test(lower));
  if (matchedPattern) {
    return matchedPattern[1];
  }

  const tokenHits = queryTokens.filter(token => hasTokenBoundary(lower, token));
  return queryTokens.length > 0 && tokenHits.length === 0 ? "Missing item keywords" : "";
}

function confidenceScore({ query, category, item }) {
  const title = String(item.title || "").toLowerCase();
  const queryTokens = tokenize(query);
  const exactPhrase = String(query || "").trim().toLowerCase();
  const hints = categoryHints(category);
  let score = 45;

  if (exactPhrase && hasTokenBoundary(title, exactPhrase)) score += 25;

  const tokenMatches = queryTokens.filter(token => hasTokenBoundary(title, token)).length;
  score += Math.min(20, tokenMatches * 4);

  const hintMatches = hints.filter(token => hasTokenBoundary(title, token)).length;
  score += Math.min(8, hintMatches * 2);

  if (item.condition) {
    const condition = item.condition.toLowerCase();
    if (condition.includes("new")) score += 2;
    if (condition.includes("used")) score += 4;
  }

  const refLikeTokens = queryTokens.filter(token => /\d/.test(token) || /[a-z]+\d|\d+[a-z]+/i.test(token));
  if (refLikeTokens.length) {
    const matchedRefs = refLikeTokens.filter(token => hasTokenBoundary(title, token)).length;
    score += Math.min(18, matchedRefs * 9);
  }

  return Math.max(1, Math.min(99, score));
}

function parsePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeItem(item, query, category) {
  const priceCurrency = item.price?.currency || item.price?.currencyCode || "USD";
  const shippingCurrency = item.shippingOptions?.[0]?.shippingCost?.currency || item.shippingOptions?.[0]?.shippingCost?.currencyCode || priceCurrency;
  const price = parsePrice(item.price?.value);
  const shipping = parsePrice(item.shippingOptions?.[0]?.shippingCost?.value) || 0;
  const confidence = confidenceScore({ query, category, item });

  return {
    title: item.title || "Untitled eBay listing",
    price,
    shipping,
    condition: item.condition || item.conditionId || "Unknown",
    source: "eBay Browse API",
    url: item.itemWebUrl || item.itemAffiliateWebUrl || null,
    image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
    soldDate: item.itemEndDate || null,
    confidence,
    currency: priceCurrency,
    shippingCurrency,
    buyingOptions: item.buyingOptions || []
  };
}

function normalizeSoldItem(item, query, category) {
  const salePrice = item.lastSoldPrice || item.price || item.sellingPrice || item.currentBidPrice;
  const shippingCost = item.shippingOptions?.[0]?.shippingCost || item.shippingCost;
  const priceCurrency = salePrice?.currency || salePrice?.currencyCode || "USD";
  const shippingCurrency = shippingCost?.currency || shippingCost?.currencyCode || priceCurrency;
  const price = parsePrice(salePrice?.value || salePrice);
  const shipping = parsePrice(shippingCost?.value || shippingCost) || 0;
  const title = item.title || item.itemGroupTitle || "Untitled eBay sold comp";
  const confidence = confidenceScore({ query, category, item: { ...item, title } });

  return {
    title,
    price,
    shipping,
    condition: item.condition || item.conditionId || "Unknown",
    source: "eBay Marketplace Insights API",
    url: item.itemWebUrl || item.itemHref || item.itemAffiliateWebUrl || null,
    image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
    soldDate: item.lastSoldDate || item.itemEndDate || null,
    confidence,
    currency: priceCurrency,
    shippingCurrency,
    buyingOptions: ["SOLD"]
  };
}

async function searchEbay({ item, category, limit = 20 }) {
  const query = buildSearchQuery({ item, category });
  const token = await getAccessToken();
  const isRatchetSearch = /\bratchets?\b/i.test(query);

  const params = new URLSearchParams({
    q: query,
    limit: String(isRatchetSearch ? Math.max(limit, 50) : limit)
  });

  const response = await fetch(`${API_BASE}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`eBay search failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
  const queryTokens = tokenize(query);
  const rejected = [];

  const normalized = items
    .map(listing => normalizeItem(listing, query, category))
    .filter(listing => {
      const reason = filterReason(listing.title, queryTokens);
      const currencyMismatch = listing.currency !== "USD" || listing.shippingCurrency !== "USD";
      if (reason || listing.price === null || currencyMismatch) {
        rejected.push({ ...listing, reason: reason || (currencyMismatch ? "Non-USD listing" : "Missing price") });
        return false;
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence || a.price - b.price);

  return {
    query,
    total: data.total || normalized.length,
    results: normalized,
    rejected
  };
}

async function searchEbaySold({ item, category, limit = 20 }) {
  const query = buildSearchQuery({ item, category });
  const token = await getAccessToken(INSIGHTS_SCOPE);

  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    sort: "-lastSoldDate"
  });

  const response = await fetch(`${API_BASE}/buy/marketplace_insights/v1_beta/item_sales/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`eBay sold-comps search failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const items = Array.isArray(data.itemSales) ? data.itemSales : Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
  const queryTokens = tokenize(query);
  const rejected = [];

  const normalized = items
    .map(listing => normalizeSoldItem(listing, query, category))
    .filter(listing => {
      const reason = filterReason(listing.title, queryTokens);
      const currencyMismatch = listing.currency !== "USD" || listing.shippingCurrency !== "USD";
      if (reason || listing.price === null || currencyMismatch) {
        rejected.push({ ...listing, reason: reason || (currencyMismatch ? "Non-USD sold comp" : "Missing sale price") });
        return false;
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence || b.price - a.price);

  return {
    query,
    total: data.total || normalized.length,
    results: normalized,
    rejected
  };
}

module.exports = {
  hasCredentials,
  searchEbay,
  searchEbaySold
};

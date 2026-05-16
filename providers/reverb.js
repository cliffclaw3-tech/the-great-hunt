const REVERB_API_BASE = "https://reverb.com/api";

function hasCredentials() {
  return Boolean(process.env.REVERB_TOKEN);
}

function buildSearchQuery({ item, category }) {
  return String(item || category || "").trim();
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function filterReason(title, queryTokens) {
  const lower = String(title || "").toLowerCase();
  const blockedPatterns = [
    [/for parts|parts only|\bparts\b|broken|not working|repair/, "Parts or repair listing"],
    [/reproduction|replica|fake|counterfeit/, "Reproduction or authenticity risk"],
    [/empty box/, "Box or packaging only"]
  ];

  const matchedPattern = blockedPatterns.find(([pattern]) => pattern.test(lower));
  if (matchedPattern) {
    return matchedPattern[1];
  }

  const tokenHits = queryTokens.filter(token => lower.includes(token));
  return queryTokens.length > 0 && tokenHits.length === 0 ? "Missing item keywords" : "";
}

function parseMoney(value) {
  if (value && typeof value === "object") {
    const amount = value.amount || value.value;
    const parsed = Number(amount);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function confidenceScore({ query, item }) {
  const title = String(item.title || "").toLowerCase();
  const queryTokens = tokenize(query);
  const exactPhrase = String(query || "").trim().toLowerCase();
  let score = 45;

  if (exactPhrase && title.includes(exactPhrase)) score += 25;
  score += Math.min(22, queryTokens.filter(token => title.includes(token)).length * 5);

  const refLikeTokens = queryTokens.filter(token => /\d/.test(token) || /[a-z]+\d|\d+[a-z]+/i.test(token));
  score += Math.min(18, refLikeTokens.filter(token => title.includes(token)).length * 9);

  if (item.condition?.display_name) score += 4;
  if (item.make?.name || item.model) score += 4;

  return Math.max(1, Math.min(99, score));
}

function normalizeListing(item, query) {
  const price = parseMoney(item.price);
  const shipping = parseMoney(item.shipping?.rate) || parseMoney(item.shipping?.us_rate) || 0;

  return {
    title: item.title || "Untitled Reverb listing",
    price,
    shipping,
    condition: item.condition?.display_name || item.condition || "Unknown",
    source: "Reverb API",
    url: item._links?.web?.href || item.web_url || null,
    image: item.photos?.[0]?._links?.large_crop?.href || item.photos?.[0]?._links?.full?.href || null,
    soldDate: null,
    confidence: confidenceScore({ query, item }),
    buyingOptions: ["FIXED_PRICE"]
  };
}

async function searchReverb({ item, category, limit = 20 }) {
  if (!hasCredentials()) {
    throw new Error("Missing Reverb token");
  }

  const query = buildSearchQuery({ item, category });
  const params = new URLSearchParams({
    query,
    per_page: String(limit)
  });

  const response = await fetch(`${REVERB_API_BASE}/listings?${params.toString()}`, {
    headers: {
      Accept: "application/hal+json",
      "X-Auth-Token": process.env.REVERB_TOKEN
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Reverb search failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const listings = Array.isArray(data.listings) ? data.listings : [];
  const queryTokens = tokenize(query);
  const rejected = [];
  const normalized = listings
    .map(listing => normalizeListing(listing, query))
    .filter(listing => {
      const reason = filterReason(listing.title, queryTokens);
      if (reason || listing.price === null || !listing.url) {
        rejected.push({ ...listing, reason: reason || "Missing price or URL" });
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

module.exports = {
  hasCredentials,
  searchReverb
};

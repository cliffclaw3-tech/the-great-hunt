require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { searchEbay, searchEbaySold, hasCredentials: hasEbayCredentials } = require("./providers/ebay");
const { searchReverb, hasCredentials: hasReverbCredentials } = require("./providers/reverb");
const { crawlUrl, hasCrawl4Ai } = require("./providers/crawl4ai");
const { lookupProductByBarcode, hasProductLookupConfig } = require("./providers/productLookup");

const root = __dirname;
const dataPath = path.join(root, "data", "watchlists.json");
const findsPath = path.join(root, "data", "finds.json");
const envPath = path.join(root, ".env");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

function money(value) {
  return `$${Math.round(value).toLocaleString()}`;
}

function categoryMultiplier(category) {
  return category === "Watches"
    ? 1.72
    : category === "Books"
      ? 2.55
      : category === "Pens"
        ? 1.95
        : category === "Retail arbitrage"
          ? 1.55
          : ["Comic books", "Sports cards", "Sports memorabilia", "Coins", "Stamps", "Art and paintings", "Vases and pottery", "Jewelry"].includes(category)
            ? 2.2
            : 1.68;
}

function conditionDetails(condition) {
  const map = {
    rough: {
      label: "Rough / untested",
      multiplier: 0.72,
      note: "Priced down for unknowns, repairs, missing pieces, or buyer risk."
    },
    working: {
      label: "Working",
      multiplier: 0.9,
      note: "Working but not premium-condition pricing."
    },
    clean: {
      label: "Clean",
      multiplier: 1,
      note: "Baseline pricing assumes clean used condition."
    },
    restored: {
      label: "Restored / serviced",
      multiplier: 1.12,
      note: "Priced up for documented service, restoration, or verified functionality."
    },
    sealed: {
      label: "New / sealed",
      multiplier: 1.18,
      note: "Priced up for new, sealed, or box-complete condition."
    }
  };

  return map[condition] || map.clean;
}

function conditionHints(category) {
  const map = {
    Watches: ["Service receipt or timing result", "Dial, hands, and lume originality", "Bracelet/end-link fit", "Polishing and case sharpness"],
    Books: ["Edition and issue points", "Dust jacket state", "Ex-library marks", "Inscriptions, stains, and foxing"],
    "Comic books": ["Issue number and variant", "Publisher and year", "Grade or slab label", "Spine ticks, tears, cutouts, and restoration"],
    "Sports cards": ["Player, year, set, and card number", "Raw vs PSA/SGC/BGS grade", "Corners, centering, edges, and surface", "Rookie, parallel, serial number, or autograph"],
    "Sports memorabilia": ["Player/team/event match", "COA or authentication", "Game-used vs replica", "Signature quality and provenance"],
    Coins: ["Country, denomination, year, and mint mark", "Raw vs PCGS/NGC/ANACS grade", "Metal content, variety, and errors", "Cleaning, scratches, rim damage, and authenticity"],
    Stamps: ["Country, year, catalog number, and denomination", "Mint vs used, hinge, gum, and perforations", "Watermark, color, overprint, and cancellation"],
    "Art and paintings": ["Artist signature and back labels", "Medium, size, frame, and provenance", "Condition, repairs, and canvas/paper quality", "Auction history or gallery documentation"],
    "Vases and pottery": ["Maker mark and country", "Shape, glaze, pattern, and period", "Chips, cracks, crazing, and repairs", "Size and pair/set completeness"],
    Jewelry: ["Metal mark and karat", "Gemstone type and testing", "Maker mark, weight, and condition", "Appraisal, certificate, or receipt"],
    Pens: ["Nib imprint and size", "Filling system condition", "Cracks, shrinkage, and cap fit", "Restoration needs"],
    "Vintage audio": ["Both channels tested", "Faceplate and knob condition", "Recap/service history", "Scratchy controls or hum"],
    "Retail arbitrage": ["Exact SKU/UPC", "Sealed box and return stickers", "Discontinued color or variant", "Shipping and return risk"],
    Instruments: ["Electronics tested", "Neck/fret condition", "Original parts", "Case and accessory completeness"],
    Knives: ["Blade wear and sharpening", "Lockup/action", "Box/papers", "Authenticity and local restrictions"]
  };

  return map[category] || ["Exact model or maker mark", "Completeness", "Visible damage", "Repair or cleaning needed"];
}

function everydayItemSignal(item) {
  const text = String(item || "").toLowerCase();
  const commonThrowaway = [
    "empty cup",
    "mcdonalds cup",
    "mcdonald's cup",
    "fast food cup",
    "paper cup",
    "plastic cup",
    "soda cup",
    "coffee cup",
    "water bottle",
    "empty bottle",
    "cardboard box",
    "grocery bag",
    "receipt",
    "newspaper clipping"
  ];
  const specialSignals = [
    "vintage",
    "antique",
    "promo",
    "promotional",
    "limited",
    "misprint",
    "error",
    "prototype",
    "sealed",
    "unused",
    "disney",
    "olympic",
    "super bowl",
    "pokemon",
    "star wars",
    "complete set"
  ];

  return commonThrowaway.some(term => text.includes(term)) && !specialSignals.some(term => text.includes(term));
}

function applyConditionToDeal(deal, condition) {
  const details = conditionDetails(condition);
  const baseFastSale = Number(deal.fastSale || 0);
  const ask = Number(deal.ask || 0);
  const conditionAdjustedFastSale = Math.round(baseFastSale * details.multiplier);
  const adjustedFastSale = deal.allowBelowAsk ? conditionAdjustedFastSale : Math.max(ask + 10, conditionAdjustedFastSale);
  const adjustedCompRange = deal.priceLow && deal.priceHigh
    ? `${money(deal.priceLow * details.multiplier)}-${money(deal.priceHigh * details.multiplier)}`
    : deal.compRange;

  return {
    ...deal,
    condition: details.label,
    conditionKey: condition || "clean",
    conditionMultiplier: details.multiplier,
    conditionNote: details.note,
    conditionHints: conditionHints(deal.category),
    unadjustedFastSale: Math.round(baseFastSale),
    fastSale: adjustedFastSale,
    compRange: adjustedCompRange,
    explanation: `${deal.explanation || ""} Condition selected: ${details.label}. ${details.note}`.trim()
  };
}

function rareFactFor(category, item) {
  const facts = {
    Watches: "Collectors often pay for tiny reference details: dial text, handset, bracelet end links, and service history can change the deal more than the brand name.",
    Books: "Book value often hides in edition points, dust jacket condition, and whether the copy escaped library markings.",
    "Comic books": "Comic value can jump on first appearances, variant covers, newsstand copies, and high grades, but tiny spine ticks can pull the number down fast.",
    "Sports cards": "Sports-card value often lives in tiny details: year, set, card number, rookie status, parallel, serial number, autograph, and grade.",
    "Sports memorabilia": "Memorabilia value depends heavily on authentication and provenance; an unauthenticated autograph is usually not comparable to a certified one.",
    Coins: "Coin value can hide in date, mint mark, variety, metal content, and grade, while cleaning or rim damage can crush the value.",
    Stamps: "Stamp value depends on catalog number, watermark, perforation, gum, cancellation, and condition details that casual sellers often miss.",
    "Art and paintings": "Art value depends on proof: artist, medium, size, provenance, auction history, and whether it is original or a reproduction.",
    "Vases and pottery": "Pottery and vases can swing wildly based on a tiny bottom mark, glaze, form, size, and whether chips or repairs are present.",
    Jewelry: "Jewelry value starts with testing: metal, karat, stone identity, weight, maker, and certificates matter more than a pretty photo.",
    Pens: "Vintage pens can look ordinary until the nib imprint, filling system, or barrel date code tells a better story.",
    "Retail arbitrage": "Closeout finds can win on discontinued colors and exact SKU scarcity, but shipping, returns, and platform fees decide the real spread.",
    "Vintage audio": "Vintage audio buyers love clean faceplates and complete knob sets, because cosmetic parts can be harder to source than basic electronics work."
  };

  return facts[category] || `${item} may have value hiding in maker marks, model numbers, materials, and condition clues that casual sellers skip.`;
}

function fallbackPhoto(category, item) {
  return {
    src: "assets/hunt-desk.png",
    alt: `${item} research photo reference`,
    position: category === "Books" ? "25% 45%" : category === "Pens" ? "76% 24%" : category === "Watches" ? "72% 42%" : "82% 38%"
  };
}

function isCollectibleCategory(category) {
  return ["Comic books", "Sports cards", "Sports memorabilia", "Coins", "Stamps", "Art and paintings", "Vases and pottery", "Jewelry"].includes(category);
}

function collectibleReferenceLinks(item, category) {
  const encoded = encodeURIComponent(item);
  if (category === "Comic books") {
    return [
      [`PriceCharting comics: ${item}`, `https://www.pricecharting.com/search-products?q=${encoded}&type=prices`],
      [`ComicsPriceGuide: ${item}`, `https://comicspriceguide.com/search?search=${encoded}`]
    ];
  }
  if (category === "Sports cards") {
    return [
      [`PSA price guide: ${item}`, `https://www.psacard.com/priceguide?s=${encoded}`],
      [`130 Point sales search: ${item}`, `https://130point.com/sales/?search=${encoded}`]
    ];
  }
  if (category === "Sports memorabilia") {
    return [
      [`PSA/DNA cert lookup`, "https://www.psacard.com/cert/"],
      [`JSA cert lookup`, "https://www.spenceloa.com/verify-authenticity/"]
    ];
  }
  if (category === "Coins") {
    return [
      [`PCGS price guide: ${item}`, `https://www.pcgs.com/prices`],
      [`NGC price guide: ${item}`, `https://www.ngccoin.com/price-guide/`]
    ];
  }
  if (category === "Stamps") {
    return [
      [`Colnect stamp search: ${item}`, `https://colnect.com/en/stamps/list/keywords/${encoded}`],
      [`StampWorld catalog: ${item}`, `https://www.stampworld.com/en/stamps/`]
    ];
  }
  if (category === "Art and paintings") {
    return [
      [`LiveAuctioneers art: ${item}`, `https://www.liveauctioneers.com/search/?keyword=${encoded}`],
      [`Invaluable art: ${item}`, `https://www.invaluable.com/search?query=${encoded}`]
    ];
  }
  if (category === "Vases and pottery") {
    return [
      [`WorthPoint pottery: ${item}`, `https://www.worthpoint.com/inventory/search?query=${encoded}`],
      [`LiveAuctioneers pottery: ${item}`, `https://www.liveauctioneers.com/search/?keyword=${encoded}`]
    ];
  }
  if (category === "Jewelry") {
    return [
      [`WorthPoint jewelry: ${item}`, `https://www.worthpoint.com/inventory/search?query=${encoded}`],
      [`GIA report check`, "https://www.gia.edu/report-check-landing"]
    ];
  }
  return [];
}

function buildFallbackDeal(input, reason = "Using local estimate fallback.") {
  const item = String(input.item || "Untitled item").trim();
  const category = inferCategoryFromItem(item) || String(input.category || "Vintage audio");
  const ground = String(input.ground || input.source || "Estate sale");
  const ask = Number(input.ask || 0);
  const distance = Number(input.distance || 0);
  const condition = String(input.condition || "clean");
  const multiplier = categoryMultiplier(category);
  const missingAsk = ask <= 0;
  const highRange = ask * (multiplier + 0.55);
  const collectibleLinks = collectibleReferenceLinks(item, category);
  const collectibleNote = isCollectibleCategory(category)
    ? " Expert-check mode: exact identifiers, marks, maker, artist, grade, appraisal, provenance, and authentication can change value dramatically."
    : "";

  return applyConditionToDeal({
    title: item,
    category,
    ground,
    source: "Local fallback estimate",
    ask,
    fastSale: missingAsk ? 0 : Math.max(ask + 20, ask * multiplier),
    allowBelowAsk: missingAsk,
    comps: missingAsk || isCollectibleCategory(category) ? 0 : category === "Vintage audio" ? 4 : 6,
    compRange: missingAsk ? "$0-$0" : `${money(ask * 1.45)}-${money(highRange)}`,
    absorption: multiplier > 2 ? "hot" : "steady",
    distance,
    confidence: missingAsk ? 38 : isCollectibleCategory(category) ? 48 : category === "Vintage audio" ? 69 : 74,
    photo: fallbackPhoto(category, item),
    compLinks: [
      ...collectibleLinks,
      [`eBay sold: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item)}&LH_Sold=1&LH_Complete=1`],
      [`WorthPoint archive: ${item}`, `https://www.worthpoint.com/inventory/search?query=${encodeURIComponent(item)}`],
      [`Google Shopping: ${item}`, `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(item)}`]
    ],
    rareFact: rareFactFor(category, item),
    checklist: isCollectibleCategory(category)
      ? ["Find exact identifiers, marks, maker, artist, grade, or appraisal clues", "Do not compare raw or unverified items to authenticated, graded, or appraised examples", "Use a local expert before paying real money"]
      : ["Match exact model, SKU, or reference", "Confirm condition tier manually", "Check fees, repairs, and haul-away friction before payment"],
    explanation: missingAsk
      ? `${reason} No seller ask was entered and live comps were unavailable, so the app is not inventing a resale value. Add the seller ask, exact model, or a clearer maker/model photo.`
      : `${reason}${collectibleNote}`,
    disclaimer: "Fallback estimate used because live eBay comps were unavailable."
  }, condition);
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * p)));
  return sortedValues[index];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function absorptionFor(count) {
  return count >= 8 ? "hot" : count >= 4 ? "steady" : "slow";
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function tokenizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/music\s+master/g, "musicmaster")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function inferCategoryFromItem(item) {
  const text = String(item || "").toLowerCase();
  const rules = [
    [/shoe|shoes|sneaker|sneakers|tennis shoe|running shoe|trainer|cleat|boot|boots|sandal|sandals|nike|adidas|new balance|asics|brooks|hoka|skechers|puma|reebok|converse|vans/, "Retail arbitrage"],
    [/apparel|clothing|shirt|pants|jacket|coat|dress|jeans|hoodie|sweater|sweatshirt|shorts|socks|hat|cap|size \d+|mens|women'?s|kids/, "Retail arbitrage"],
    [/painting|fine art|\bart\b|artist|canvas|oil painting|watercolor|lithograph|serigraph|signed print|framed art|sculpture|gallery label|provenance/, "Art and paintings"],
    [/vase|vases|pottery|ceramic|porcelain|stoneware|raku|majolica|rookwood|roseville|weller|mccoy|fiesta|maker mark|bottom mark|glaze/, "Vases and pottery"],
    [/jewelry|jewellery|necklace|bracelet|earrings|brooch|pendant|sterling silver|diamond|gemstone|turquoise|karat|\b10k\b|\b14k\b|\b18k\b|\b925\b|tiffany|cartier|appraisal|gold ring|silver ring/, "Jewelry"],
    [/comic|comics|cgc|cbcs|marvel|dc comics|spider[- ]?man|batman|x[- ]?men|superman|wolverine|hulk|venom|spawn|issue #?|\b9\.8\b/, "Comic books"],
    [/baseball card|basketball card|football card|hockey card|sports card|rookie card|\bpsa\b|\bsgc\b|\bbgs\b|beckett|topps|panini|bowman|fleer|donruss|upper deck|prizm|select|optic|card #?/, "Sports cards"],
    [/memorabilia|autograph|signed jersey|signed ball|jersey|helmet|game used|game-used|psa\/dna|\bjsa\b|fanatics coa|coa\b/, "Sports memorabilia"],
    [/coin|coins|silver dollar|gold coin|morgan dollar|peace dollar|wheat cent|indian head|buffalo nickel|mercury dime|proof set|mint mark|\bpcgs\b|\bngc\b|\banacs\b|numismatic/, "Coins"],
    [/stamp|stamps|postage|first day cover|cover\b|watermark|perforation|overprint|hinged|no gum|scott catalog|philatelic/, "Stamps"],
    [/guitar|fender|gibson|mandolin|banjo|saxophone|violin|amp\b|amplifier/, "Instruments"],
    [/parker|waterman|montblanc|fountain pen|\bpen\b|vacumatic|carene/, "Pens"],
    [/marantz|receiver|turntable|speaker|stereo|sansui|pioneer/, "Vintage audio"],
    [/omega|rolex|seiko|watch|seamaster|submariner/, "Watches"],
    [/hobbit|book|first edition|dust jacket|tolkien|signed copy/, "Books"],
    [/le creuset|skillet|cookware|staub|all-clad|closeout|clearance/, "Retail arbitrage"],
    [/craftsman|snap-on|matco|mac tools|ratchet|socket|wrench|pliers|screwdriver|hammer|tool|saw|drill/, "Tools"],
    [/camera|nikon|canon|leica|lens|film/, "Cameras"],
    [/knife|case xx|benchmade|spyderco/, "Knives"]
  ];

  return rules.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function stripHtml(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&gt;/gi, ">")
      .replace(/&lt;/gi, "<")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  );
}

function extractMetaContent(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(pattern)?.[1] || "";
}

function cleanSourceTitle(title) {
  return normalizeWhitespace(String(title || "")
    .replace(/\s+-\s+musical instruments[\s\S]*$/i, "")
    .replace(/\s+-\s+by owner[\s\S]*$/i, "")
    .replace(/\s+-\s+sale\s+-\s+craigslist$/i, "")
    .replace(/\s+-\s+craigslist$/i, "")
    .replace(/\s+\|\s+.*$/i, ""));
}

function extractPriceFromHtml(html) {
  const jsonLdPrice = html.match(/"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i)?.[1];
  if (jsonLdPrice) return Math.round(Number(jsonLdPrice));

  const classPrice = html.match(/class=["'][^"']*price[^"']*["'][^>]*>\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i)?.[1];
  if (classPrice) return Math.round(Number(classPrice.replaceAll(",", "")));

  return 0;
}

function extractJsonLdProduct(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      if (data && (data["@type"] === "Product" || data.offers)) return data;
    } catch {
      // Ignore malformed third-party structured data.
    }
  }

  return null;
}

const radarCategorySignals = [
  { category: "Vintage audio", terms: ["marantz", "sansui", "pioneer", "receiver", "turntable", "speakers", "tube amp", "stereo"] },
  { category: "Watches", terms: ["omega", "rolex", "seiko", "watch", "wristwatch", "chronograph"] },
  { category: "Books", terms: ["first edition", "signed book", "hardcover", "tolkien", "dust jacket", "rare books"] },
  { category: "Pens", terms: ["fountain pen", "parker", "waterman", "montblanc", "vacumatic", "pelikan"] },
  { category: "Instruments", terms: ["guitar", "fender", "gibson", "synth", "keyboard", "mandolin", "banjo"] },
  { category: "Retail arbitrage", terms: ["le creuset", "staub", "all-clad", "new in box", "sealed", "closeout"] },
  { category: "Knives", terms: ["case knife", "pocket knife", "benchmade", "buck knife"] },
  { category: "Tools", terms: ["snap-on", "matco", "woodworking tools", "lathe", "starrett"] },
  { category: "Cameras", terms: ["leica", "nikon", "canon ae-1", "hasselblad", "camera lenses"] }
];

const radarSourceSamples = [
  {
    title: "Northside estate sale preview",
    sourceType: "Estate sale company",
    sourceName: "Sample estate sale listing",
    url: "https://www.estatesales.net/",
    distance: 9,
    text: "Packed basement and den sale with Marantz stereo receiver, Pioneer turntable, Snap-on tool chest, Nikon lenses, fountain pens, Le Creuset cookware, framed art, and old advertising signs."
  },
  {
    title: "Online auction preview ending Saturday",
    sourceType: "Auction house",
    sourceName: "Sample local auction",
    url: "https://www.auctionzip.com/",
    distance: 22,
    text: "Catalog includes Omega wristwatch, Parker 51 fountain pen lot, vintage Case knives, Gibson acoustic guitar, comic boxes, sterling flatware, and mid century lamps."
  },
  {
    title: "Classified moving sale",
    sourceType: "Classifieds",
    sourceName: "Sample classifieds scan",
    url: "https://www.craigslist.org/",
    distance: 14,
    text: "Moving sale ad mentions receiver, old cameras, Leica lens, woodworking tools, first edition books, record collection, and patio furniture."
  },
  {
    title: "Church rummage sale notice",
    sourceType: "Newspaper/community notice",
    sourceName: "Sample community bulletin",
    url: "",
    distance: 4,
    text: "Donation sale with jewelry, old watches, hardcover books, kitchenware, hand tools, musical instruments, and estate cleanout boxes."
  }
];

function scoreRadarText(text, keywords = []) {
  const lower = String(text || "").toLowerCase();
  const categories = radarCategorySignals
    .map(signal => ({
      category: signal.category,
      hits: signal.terms.filter(term => lower.includes(term))
    }))
    .filter(result => result.hits.length);
  const keywordHits = keywords.filter(keyword => keyword && lower.includes(keyword.toLowerCase()));
  const score = Math.min(98, 34 + keywordHits.length * 11 + categories.reduce((sum, result) => sum + result.hits.length * 7, 0));
  const category = categories[0]?.category || "Mixed sale";

  return { score, category, categories, keywordHits };
}

function buildRadarLead(source, keywords = [], index = 0) {
  const text = normalizeWhitespace(source.text || "");
  if (source.error) {
    return {
      id: `${Date.now()}-${index}`,
      title: source.title || "Source needs review",
      category: "Source review",
      sourceType: source.sourceType || "Source needs review",
      sourceName: source.sourceName || "Submitted source",
      sourceUrl: source.url || "",
      distance: Number(source.distance || 0),
      score: 12,
      signals: ["manual review"],
      keywordHits: [],
      summary: text || "This source could not be scanned automatically.",
      lookupItem: "",
      suggestedGround: "Estate sale",
      needsReview: true,
      nextSteps: [
        "Open the source manually",
        "Copy any item names into Lookup",
        "Try a public sale preview page if this source blocks scanning"
      ]
    };
  }

  const scoring = scoreRadarText(`${source.title} ${text}`, keywords);
  const topSignals = scoring.categories.flatMap(result => result.hits.slice(0, 3)).slice(0, 7);
  const title = cleanSourceTitle(source.itemTitle || source.title) || `${scoring.category} opportunity`;
  const terms = scoring.keywordHits.length ? scoring.keywordHits : topSignals;
  const lookupItem = source.itemTitle || title || (terms.length ? terms[0] : scoring.category);

  return {
    id: `${Date.now()}-${index}`,
    title,
    category: scoring.category,
    sourceType: source.sourceType || "Public web page",
    sourceName: source.sourceName || "Submitted source",
    sourceUrl: source.url || "",
    scanner: source.scanner || "",
    ask: Number(source.ask || 0),
    photo: source.image ? { src: source.image, alt: `${title} source photo`, position: "center" } : null,
    distance: Number(source.distance || 12 + index * 4),
    score: scoring.score,
    signals: topSignals,
    keywordHits: scoring.keywordHits,
    summary: text.slice(0, 280),
    lookupItem,
    suggestedGround: source.sourceType && source.sourceType.toLowerCase().includes("auction") ? "Auction" : source.sourceType && source.sourceType.toLowerCase().includes("classified") ? "Marketplace" : "Estate sale",
    nextSteps: [
      "Open the source and confirm photos or preview time",
      "Research the strongest named item before driving",
      "Save the lead only after checking condition and pickup friction"
    ]
  };
}

function splitKeywords(value) {
  return String(value || "")
    .split(",")
    .map(keyword => keyword.trim())
    .filter(Boolean)
    .slice(0, 24);
}

async function fetchRadarSource(rawUrl, index) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only public http/https pages can be scanned");
  }

  try {
    const crawled = await crawlUrl(url.toString());
    const metadata = crawled.metadata || {};
    const markdown = normalizeWhitespace(crawled.markdown || "");
    const html = crawled.cleanedHtml || crawled.html || "";
    const product = html ? extractJsonLdProduct(html) : null;
    const title = product?.name || metadata.title || metadata["og:title"] || url.hostname;
    const image = crawled.image || (Array.isArray(product?.image) ? product.image[0] : product?.image) || metadata.image || metadata["og:image"] || "";
    const sourceType = url.hostname.includes("craigslist")
      ? "Classifieds"
      : /auction|hibid|bid|liveauction/i.test(`${url.hostname} ${title}`)
        ? "Auction house"
        : /estate/i.test(`${url.hostname} ${title} ${markdown}`)
          ? "Estate sale company"
          : "Smart web scan";

    return {
      title: stripHtml(title),
      itemTitle: cleanSourceTitle(stripHtml(title)),
      sourceType,
      sourceName: url.hostname,
      url: url.toString(),
      ask: product?.offers?.price ? Math.round(Number(product.offers.price)) : html ? extractPriceFromHtml(html) : 0,
      image,
      distance: 10 + index * 5,
      text: markdown || stripHtml(html).slice(0, 9000),
      scanner: "Crawl4AI"
    };
  } catch {
    // Fall back to the lightweight scanner when Crawl4AI is not installed or the page blocks browser crawling.
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.6",
      "User-Agent": "TheGreatHuntPrototype/0.1 public-source-preview"
    },
    redirect: "follow"
  });

  if (!response.ok) throw new Error(`Source returned ${response.status}`);
  const html = await response.text();
  const product = extractJsonLdProduct(html);
  const title = product?.name || extractMetaContent(html, "og:title") || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url.hostname;
  const image = Array.isArray(product?.image) ? product.image[0] : product?.image || extractMetaContent(html, "og:image");
  const sourceType = url.hostname.includes("craigslist") ? "Classifieds" : "Public web page";

  return {
    title: stripHtml(title),
    itemTitle: cleanSourceTitle(stripHtml(title)),
    sourceType,
    sourceName: url.hostname,
    url: url.toString(),
    ask: product?.offers?.price ? Math.round(Number(product.offers.price)) : extractPriceFromHtml(html),
    image,
    distance: 10 + index * 5,
    text: stripHtml(html).slice(0, 9000),
    scanner: "Basic fetch"
  };
}

async function enrichRadarLeadWithComps(lead) {
  if (!lead.ask || lead.needsReview) return lead;

  try {
    const compDeal = await buildLookupDeal({
      item: lead.lookupItem || lead.title,
      category: lead.category === "Mixed sale" || lead.category === "Source review" ? "Vintage audio" : lead.category,
      ground: lead.suggestedGround || "Marketplace",
      condition: "clean",
      ask: lead.ask,
      distance: lead.distance
    });

    return {
      ...lead,
      compDeal: {
        ...compDeal,
        title: lead.lookupItem || compDeal.title,
        source: lead.sourceName || compDeal.source,
        liveListingUrl: lead.sourceUrl || compDeal.liveListingUrl,
        photo: lead.photo || compDeal.photo
      }
    };
  } catch (error) {
    return {
      ...lead,
      compError: `Comp lookup did not complete: ${error.message}`
    };
  }
}

function compQualityReason({ result, item, category, ask }) {
  const title = String(result.title || "").toLowerCase();
  const queryTokens = tokenizeText(item);
  const titleTokens = tokenizeText(title);
  const normalizedTitle = titleTokens.join(" ");
  const titleCompact = normalizedTitle.replace(/\s+/g, "");
  const queryCompact = queryTokens.join("");
  const stopWords = new Set(["the", "and", "with", "for", "vintage", "original", "rare", "old", "used"]);
  const importantTokens = queryTokens
    .filter(token => token.length > 2 && !stopWords.has(token))
    .filter((token, index, array) => array.indexOf(token) === index);
  const matchedImportant = importantTokens.filter(token => titleTokens.includes(token) || titleCompact.includes(token));
  const partPatterns = {
    Instruments: /tuners?|tuning pegs?|control plate|pickguard|pickup|neck plate|\bneck\b|\bbody\b|bridge cover|knobs?|potentiometer|wiring harness|loaded guard|decals?/,
    Watches: /strap|band|bracelet link|bezel insert|dial only|hands only|movement only|caseback|crystal|crown stem/,
    "Vintage audio": /lamp|led|fuse|knobs?|faceplate|manual|remote|feet|dial glass|speaker foam/,
    Pens: /nib only|cap only|converter|refill|cartridge|empty box|clip only/,
    Books: /poster|dvd|blu-ray|audio cd|study guide/,
    "Retail arbitrage": /lid only|brush|cleaner|scrub|replacement|mini|magnet/,
    Tools: /tool box|toolbox|tool chest|cabinet|drawer|organizer|battery|charger|case only|manual|parts|repair|adapter|extension|socket only|single socket|bit set|socket set|wrench set|ratchet set|impact|drill|saw|router|lathe/
  };

  const partPattern = partPatterns[category];
  if (partPattern?.test(title)) return "Likely part or accessory, not the full item";

  if (category === "Tools") {
    const itemText = item.toLowerCase();
    const queryNeedsRatchet = /\bratchets?\b/.test(itemText);
    const queryLooksSingle = /\bratchets?\b|\bwrench\b|\bpliers?\b|\bscrewdriver\b|\bhammer\b|\bsocket wrench\b/.test(itemText)
      && !/\bset\b|\bkit\b|\blot\b|\bchest\b|\bbox\b|\bcollection\b/.test(itemText);
    const listingLooksSet = /\bset\b|\bkit\b|\blot\b|\bcollection\b|\b\d+\s*(pc|piece|pieces)\b/.test(title);
    const listingLooksSocketOnly = /\bsocket\b/.test(title) && !/\bratchets?\b/.test(title);
    const ratchetHandleSignal = /\bratchets?\b|quick release|pear head|round head|flex head|comfort grip|teeth/.test(title);
    const socketPartSignal = /\bsocket\b/.test(title) && /(shallow|deep|\b\d+\s*pt\b|\b\d+-pt\b|\b\d+\s*mm\b|standard sae|metric mm|drive shallow|drive deep)/.test(title);
    const socketTitleNeedsHandle = /\bsocket\b/.test(title) && !ratchetHandleSignal;

    if (queryLooksSingle && listingLooksSet) {
      return "Tool set or lot, not a single hand tool";
    }

    if (queryNeedsRatchet && socketPartSignal) {
      return "Socket part, not a ratchet handle";
    }

    if (queryNeedsRatchet && !ratchetHandleSignal) {
      return "Missing ratchet in title";
    }

    if (queryNeedsRatchet && socketTitleNeedsHandle) {
      return "Socket listing, not a ratchet handle";
    }

    if (queryNeedsRatchet && listingLooksSocketOnly) {
      return "Socket-only listing, not a ratchet";
    }
  }

  if (importantTokens.length >= 3 && matchedImportant.length < Math.ceil(importantTokens.length * 0.6)) {
    return "Missing too many exact item terms";
  }

  if (queryCompact.length >= 8 && !titleCompact.includes(queryCompact) && matchedImportant.length < Math.max(2, importantTokens.length - 1)) {
    return "Loose model match";
  }

  const total = Number(result.total || result.price || 0);
  if (ask >= 500 && total > 0 && total < ask * 0.35) {
    return "Price is too far below the source ask, likely a part or weak comp";
  }

  if (Number(result.confidence || 0) < 58) {
    return "Low title-match confidence";
  }

  return "";
}

async function buildRadarScan(body) {
  const keywords = splitKeywords(body.keywords);
  const urls = String(body.sources || "")
    .split(/\r?\n/)
    .map(url => url.trim())
    .filter(Boolean)
    .slice(0, 5);
  const fetched = [];

  for (const [index, url] of urls.entries()) {
    try {
      fetched.push(await fetchRadarSource(url, index));
    } catch (error) {
      fetched.push({
        title: `Could not scan ${url}`,
        sourceType: "Source needs review",
        sourceName: url,
        url,
        distance: 0,
        error: true,
        text: `Scan failed: ${error.message}. Open this source manually or try a public sale page that does not block automated preview.`
      });
    }
  }

  const sources = fetched.length ? fetched : radarSourceSamples;
  const leads = sources
    .map((source, index) => buildRadarLead(source, keywords, index))
    .filter(lead => lead.needsReview || lead.score >= 35 || lead.signals.length || lead.keywordHits.length)
    .sort((a, b) => b.score - a.score);
  const enrichedLeads = await Promise.all(leads.map(enrichRadarLeadWithComps));

  return {
    zip: String(body.zip || "").trim(),
    radius: Number(body.radius || 0),
    keywords,
    scanned: sources.length,
    liveSources: fetched.length,
    leads: enrichedLeads
  };
}

function hasPhotoCompareInput(input) {
  return hasOpenAiVisionCredentials() && String(input.photoData || "").startsWith("data:image/");
}

async function comparePhotoComps(input, comps) {
  const imageData = String(input.photoData || "");
  const candidates = comps
    .filter(result => result.image)
    .slice(0, 8)
    .map((result, index) => ({
      id: `comp-${index}`,
      title: result.title,
      image: result.image
    }));

  if (!hasPhotoCompareInput(input) || !candidates.length) {
    return {
      results: comps,
      rejected: [],
      note: imageData ? "No comp photos were available for visual comparison." : ""
    };
  }

  const model = process.env.OPENAI_VISION_MODEL && !process.env.OPENAI_VISION_MODEL.includes("your-")
    ? process.env.OPENAI_VISION_MODEL
    : "gpt-4.1-mini";
  const prompt = [
    "You compare a user's estate-sale item photo against marketplace comp photos.",
    "Be conservative and practical. Different angle, lighting, crop, or color can still be the same item type.",
    "Score whether the comp photo appears to show the same exact item type/model as the user's photo.",
    "Return only JSON with key comparisons. comparisons must be an array of objects with: id, score, verdict, reason.",
    "score is 0-100. verdict must be one of: strong match, close match, weak match, mismatch.",
    `User item search: ${String(input.item || "Unknown item")}`,
    "The first image is the user's item. Each following image is a comp candidate, in the listed id order.",
    candidates.map(candidate => `${candidate.id}: ${candidate.title}`).join("\n")
  ].join("\n");

  const content = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: imageData, detail: "low" },
    ...candidates.flatMap(candidate => [
      { type: "input_text", text: `${candidate.id}: ${candidate.title}` },
      { type: "input_image", image_url: candidate.image, detail: "low" }
    ])
  ];

  try {
    const apiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content }]
      })
    });

    if (!apiResponse.ok) {
      return { results: comps, rejected: [], note: `Photo comparison could not run (${apiResponse.status}), so pricing used text comps only.` };
    }

    const payload = await apiResponse.json();
    const parsed = safeJsonFromText(extractResponseText(payload));
    const comparisons = Array.isArray(parsed?.comparisons) ? parsed.comparisons : [];
    const byId = new Map(comparisons.map(item => [String(item.id || ""), item]));
    const rejected = [];
    const scored = comps.map((result, index) => {
      const comparison = byId.get(`comp-${index}`);
      if (!comparison) return result;
      const rawScore = Number(comparison.score);
      const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : null;
      const verdict = normalizeWhitespace(comparison.verdict || (score >= 70 ? "strong match" : score >= 55 ? "close match" : score >= 35 ? "weak match" : "mismatch"));
      const reason = normalizeWhitespace(comparison.reason || "Visual comparison checked against the uploaded photo.");
      const adjustedConfidence = score === null
        ? result.confidence
        : Math.round((Number(result.confidence || 0) * 0.65) + (score * 0.35));

      return {
        ...result,
        confidence: adjustedConfidence,
        photoMatchScore: score,
        photoMatchVerdict: verdict,
        photoMatchReason: reason
      };
    });

    const kept = scored.filter(result => {
      if (result.photoMatchScore !== null && result.photoMatchScore !== undefined && result.photoMatchScore <= 32) {
        rejected.push({
          ...result,
          reason: `Photo mismatch: ${result.photoMatchReason || "comp image does not appear to match the uploaded item."}`
        });
        return false;
      }
      return true;
    });

    if (kept.length < 2) {
      return {
        results: scored,
        rejected: [],
        note: "Photo comparison looked inconclusive, so the app did not override the pricing set."
      };
    }

    const checkedCount = candidates.length;
    const rejectedCount = rejected.length;
    return {
      results: kept,
      rejected,
      note: rejectedCount
        ? `Photo comparison checked ${checkedCount} comp images and filtered ${rejectedCount} obvious mismatch${rejectedCount === 1 ? "" : "es"}.`
        : `Photo comparison checked ${checkedCount} comp images; no obvious photo mismatches were removed.`
    };
  } catch (error) {
    return {
      results: comps,
      rejected: [],
      note: `Photo comparison could not finish (${error.message}). Pricing used text comps only.`
    };
  }
}

async function buildRealCompDeal(input, searchResult) {
  const item = String(input.item || "Untitled item").trim();
  const category = inferCategoryFromItem(item) || String(input.category || "Vintage audio");
  const ground = String(input.ground || "Estate sale");
  const ask = Number(input.ask || 0);
  const distance = Number(input.distance || 0);
  const condition = String(input.condition || "clean");
  const results = searchResult.results || [];

  if (!results.length) {
    throw new Error("No usable eBay results after filtering");
  }

  const rawPriced = results
    .map(result => ({ ...result, total: result.price + (result.shipping || 0) }))
    .sort((a, b) => a.total - b.total);
  const qualityRejected = [];
  const priced = rawPriced.filter(result => {
    const reason = compQualityReason({ result, item, category, ask });
    if (reason) {
      qualityRejected.push({ ...result, reason });
      return false;
    }

    return true;
  });

  if (!priced.length) {
    throw new Error("No usable marketplace results after comp-quality filtering");
  }

  const photoComparison = await comparePhotoComps(input, priced);
  const photoFiltered = photoComparison.results;
  const totals = photoFiltered.map(result => result.total);
  const low = percentile(totals, 0.15);
  const medianPrice = median(totals);
  const high = percentile(totals, 0.85);
  const fastSale = ask > 0 ? Math.max(ask + 20, low * 0.97) : low * 0.97;
  const suggestedAsk = medianPrice;
  const avgConfidence = Math.round(average(photoFiltered.map(result => result.confidence)));
  const top = photoFiltered.slice(0, 6);
  const topImage = photoFiltered.find(result => result.image)?.image || null;
  const exactishMatches = photoFiltered.filter(result => result.confidence >= 75).length;
  const filteredCount = Math.max(0, Number(searchResult.total || rawPriced.length) - photoFiltered.length);
  const explanation = [
    `Built from ${photoFiltered.length} live ${searchResult.source} results for “${searchResult.query}”.`,
    `Range uses roughly the 15th/50th/85th percentile of listing + shipping totals (${money(low)} / ${money(medianPrice)} / ${money(high)}).`,
    filteredCount ? `${filteredCount} broad or low-quality marketplace results were ignored before pricing.` : "No broad marketplace results were filtered before pricing.",
    photoComparison.note,
    exactishMatches ? `${exactishMatches} listings looked like strong model/reference matches, which boosted confidence.` : "Confidence stayed moderate because exact model/reference overlap was limited."
  ].filter(Boolean).join(" ");

  return applyConditionToDeal({
    title: item,
    category,
    ground,
    source: searchResult.source,
    ask,
    fastSale: Math.round(fastSale),
    allowBelowAsk: true,
    suggestedAsk: Math.round(suggestedAsk),
    priceLow: Math.round(low),
    priceMedian: Math.round(medianPrice),
    priceHigh: Math.round(high),
    comps: photoFiltered.length,
    compRange: `${money(low)}-${money(high)}`,
    absorption: absorptionFor(photoFiltered.length),
    distance,
    confidence: avgConfidence,
    photo: topImage ? { src: topImage, alt: `${item} eBay comp photo`, position: "center" } : fallbackPhoto(category, item),
    compLinks: top.map(result => [
      `${result.condition || "Listing"}: ${result.title}`,
      result.url
    ]),
    compReview: {
      accepted: photoFiltered.slice(0, 12).map((result, index) => ({
        id: `accepted-${index}`,
        title: result.title,
        price: result.price,
        shipping: result.shipping || 0,
        total: result.total,
        condition: result.condition || "Unknown",
        source: result.source || searchResult.source,
        url: result.url,
        image: result.image || "",
        confidence: result.confidence,
        photoMatchScore: result.photoMatchScore ?? null,
        photoMatchVerdict: result.photoMatchVerdict || "",
        photoMatchReason: result.photoMatchReason || "",
        included: true
      })),
      rejected: [...photoComparison.rejected, ...qualityRejected, ...(searchResult.rejected || [])].slice(0, 12).map((result, index) => ({
        id: `rejected-${index}`,
        title: result.title,
        price: result.price || 0,
        shipping: result.shipping || 0,
        total: (result.price || 0) + (result.shipping || 0),
        condition: result.condition || "Unknown",
        source: result.source || searchResult.source,
        url: result.url,
        image: result.image || "",
        reason: result.reason || "Filtered out",
        confidence: result.confidence || 0,
        photoMatchScore: result.photoMatchScore ?? null,
        photoMatchVerdict: result.photoMatchVerdict || "",
        photoMatchReason: result.photoMatchReason || "",
        included: false
      }))
    },
    rareFact: rareFactFor(category, item),
    checklist: [
      "Match exact model, SKU, or reference",
      "Compare condition against the best-looking comp, not just the cheapest one",
      "Back out fees, shipping, repairs, and missing parts before paying"
    ],
    explanation,
    disclaimer: `Estimate uses live ${searchResult.source} listing comps and still needs your manual authenticity/condition check.`
  }, condition);
}

const liveDealSeeds = [
  { item: "Omega Seamaster vintage watch", category: "Watches", ground: "Marketplace", condition: "working", minAsk: 200, maxAsk: 1800, mustInclude: ["omega", "seamaster"], blockedTerms: ["ad", "advertisement", "pub", "strap", "band", "box"], distance: 18 },
  { item: "Parker 51 Vacumatic fountain pen", category: "Pens", ground: "Auction", condition: "working", minAsk: 35, maxAsk: 260, mustInclude: ["parker", "51"], blockedTerms: ["ink", "refill", "nib only", "box"], distance: 8 },
  { item: "Le Creuset skillet", category: "Retail arbitrage", ground: "Closeout aisle", condition: "clean", minAsk: 25, maxAsk: 160, mustInclude: ["le creuset", "skillet"], blockedTerms: ["mini", "magnet", "lid", "brush", "cleaner", "scrub"], distance: 14 },
  { item: "Marantz 2230 receiver", category: "Vintage audio", ground: "Antique shop", condition: "working", minAsk: 150, maxAsk: 900, mustInclude: ["marantz", "2230"], blockedTerms: ["lamp", "led", "fuse", "knob", "manual", "faceplate"], distance: 26 },
  { item: "Tolkien Hobbit vintage hardcover", category: "Books", ground: "Estate sale", condition: "clean", minAsk: 25, maxAsk: 350, mustInclude: ["hobbit"], blockedTerms: ["poster", "dvd", "blu-ray", "lego"], distance: 4 },
  { item: "vintage Case pocket knife", category: "Knives", ground: "Estate sale", condition: "working", minAsk: 25, maxAsk: 180, mustInclude: ["case", "knife"], blockedTerms: ["sheath only", "box only"], distance: 32 }
];

function titleMatchesSeed(seed, listing) {
  const title = String(listing.title || "").toLowerCase();
  const includesNeededTerms = (seed.mustInclude || []).every(term => title.includes(term));
  const hasBlockedTerm = (seed.blockedTerms || []).some(term => title.includes(term));
  return includesNeededTerms && !hasBlockedTerm;
}

function buildLiveDealFromListing(seed, listing, searchResult) {
  const comparableTotals = (searchResult.results || [])
    .map(result => Number(result.price || 0) + Number(result.shipping || 0))
    .filter(total => total > 0)
    .sort((a, b) => a - b);
  const ask = Math.round(Number(listing.price || 0) + Number(listing.shipping || 0));
  const medianPrice = median(comparableTotals);
  const high = percentile(comparableTotals, 0.85);
  const rawFastSale = Math.max(ask + 10, medianPrice || ask);
  const candidate = applyConditionToDeal({
    title: listing.title,
    category: seed.category,
    ground: seed.ground,
    source: listing.source || searchResult.source,
    ask,
    fastSale: Math.round(rawFastSale),
    suggestedAsk: Math.round(high || rawFastSale),
    priceLow: Math.round(percentile(comparableTotals, 0.15) || ask),
    priceMedian: Math.round(medianPrice || ask),
    priceHigh: Math.round(high || rawFastSale),
    comps: comparableTotals.length,
    compRange: comparableTotals.length ? `${money(percentile(comparableTotals, 0.15))}-${money(high)}` : `${money(ask)}-${money(rawFastSale)}`,
    absorption: absorptionFor(comparableTotals.length),
    distance: seed.distance,
    confidence: listing.confidence || 55,
    photo: listing.image ? { src: listing.image, alt: `${listing.title} marketplace photo`, position: "center" } : fallbackPhoto(seed.category, listing.title),
    compLinks: (searchResult.results || []).slice(0, 6).map(result => [
      `${result.condition || "Listing"}: ${result.title}`,
      result.url
    ]),
    rareFact: rareFactFor(seed.category, listing.title),
    checklist: [
      "Open the listing and confirm exact model or SKU",
      "Check photos against the condition hints before contacting the seller",
      "Back out shipping, fees, repairs, and pickup friction"
    ],
    explanation: `Live feed item from ${listing.source || searchResult.source}. The app compared this ask against ${comparableTotals.length} active marketplace comps for “${searchResult.query}”.`,
    disclaimer: `Estimate uses active ${listing.source || searchResult.source} listings, not guaranteed sold prices.`
  }, seed.condition);

  return {
    ...candidate,
    liveListingUrl: listing.url
  };
}

async function searchLiveSeed(seed) {
  const search = seed.category === "Vintage audio" || seed.category === "Instruments"
    ? hasReverbCredentials()
      ? searchReverb
      : searchEbay
    : searchEbay;
  const source = search === searchReverb ? "Reverb API" : "eBay Browse API";
  const result = await search({ item: seed.item, category: seed.category, limit: 16 });
  const candidates = result.results
    .filter(listing => listing.url && Number(listing.price || 0) > 0)
    .filter(listing => titleMatchesSeed(seed, listing))
    .filter(listing => {
      const total = Number(listing.price || 0) + Number(listing.shipping || 0);
      return (!seed.minAsk || total >= seed.minAsk) && (!seed.maxAsk || total <= seed.maxAsk);
    })
    .slice(0, 3)
    .map(listing => buildLiveDealFromListing(seed, listing, { ...result, source }));

  return candidates;
}

async function buildLiveDeals() {
  const settled = await Promise.allSettled(liveDealSeeds.map(searchLiveSeed));
  const deals = settled
    .flatMap(result => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => dealMathServer(b).profit - dealMathServer(a).profit)
    .slice(0, 9);

  return deals;
}

function dealMathServer(deal) {
  const profit = Number(deal.fastSale || 0) - Number(deal.ask || 0);
  const margin = deal.ask ? Math.round((profit / Number(deal.ask)) * 100) : 0;
  return { profit, margin };
}

async function buildLookupDeal(input) {
  if (everydayItemSignal(input.item)) {
    const item = String(input.item || "Everyday item").trim();
    return applyConditionToDeal({
      title: item,
      category: "Everyday item",
      ground: String(input.ground || "Estate sale"),
      source: "Photo triage",
      ask: Number(input.ask || 0),
      fastSale: 0,
      allowBelowAsk: true,
      comps: 0,
      compRange: "$0-$0",
      absorption: "thin",
      distance: Number(input.distance || 0),
      confidence: 42,
      lowValueSignal: true,
      photo: fallbackPhoto("Mixed sale", item),
      compLinks: [
        [`Check sold results anyway: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item)}&LH_Sold=1&LH_Complete=1`]
      ],
      rareFact: "Most common disposable items have no resale value, but odd promotional runs, printing errors, recalled items, and complete vintage sets can still surprise people.",
      checklist: [
        "Is it vintage, limited, promotional, or part of a known set?",
        "Is it unused, sealed, or unusually clean?",
        "Does a sold comp show real demand?",
        "If none of those are true, move on."
      ],
      explanation: "The item description matched a common everyday object with no obvious collectible signal. The app is intentionally avoiding fake precision here; it should only be researched further if you spot a real scarcity clue."
    }, String(input.condition || "clean"));
  }

  const category = String(input.category || "") || inferCategoryFromItem(input.item) || "";
  const shouldTryReverb = ["Vintage audio", "Instruments"].includes(category);
  const shouldTrySoldComps = process.env.EBAY_ENABLE_MARKETPLACE_INSIGHTS === "true";

  if (shouldTryReverb && hasReverbCredentials()) {
    try {
      const results = await searchReverb({
        item: String(input.item || ""),
        category,
        limit: 24
      });

      if (results.results.length) {
        return await buildRealCompDeal(input, { ...results, source: "Reverb API" });
      }
    } catch (error) {
      console.warn(`Reverb lookup failed: ${error.message}`);
    }
  }

  if (!hasEbayCredentials()) {
    const missing = shouldTryReverb
      ? "Reverb returned no usable comps and eBay credentials are not configured yet, so the app used the local estimate fallback."
      : "eBay credentials are not configured yet, so the app used the local estimate fallback.";
    return buildFallbackDeal(input, missing);
  }

  try {
    if (shouldTrySoldComps) {
      const soldResults = await searchEbaySold({
        item: String(input.item || ""),
        category: String(input.category || ""),
        limit: 24
      });

      if (soldResults.results.length) {
        return await buildRealCompDeal(input, { ...soldResults, source: "eBay Marketplace Insights API" });
      }
    }

    const results = await searchEbay({
      item: String(input.item || ""),
      category: String(input.category || ""),
      limit: 24
    });

    if (!results.results.length) {
      return buildFallbackDeal(input, "No usable live comps were returned after filtering, so the local estimate fallback was used.");
    }

    return await buildRealCompDeal(input, { ...results, source: "eBay Browse API" });
  } catch (error) {
    return buildFallbackDeal(input, `Live comp lookup failed (${error.message}). Local estimate fallback used.`);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function readWatchlists() {
  const file = await fs.readFile(dataPath, "utf8");
  return JSON.parse(file);
}

async function writeWatchlists(watchlists) {
  await fs.writeFile(dataPath, `${JSON.stringify(watchlists, null, 2)}\n`);
}

async function readFinds() {
  try {
    const file = await fs.readFile(findsPath, "utf8");
    return JSON.parse(file);
  } catch {
    return [];
  }
}

async function writeFinds(finds) {
  await fs.writeFile(findsPath, `${JSON.stringify(finds, null, 2)}\n`);
}

function parseEnv(text) {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith("#"))
    .reduce((values, line) => {
      const equals = line.indexOf("=");
      if (equals === -1) return values;
      values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
      return values;
    }, {});
}

function serializeEnv(values) {
  const order = [
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_ENV",
    "EBAY_ENABLE_MARKETPLACE_INSIGHTS",
    "REVERB_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_VISION_MODEL",
    "BETA_ACCESS_CODE",
    "PORT"
  ];
  const seen = new Set();
  const lines = [];

  for (const key of order) {
    if (values[key] !== undefined) {
      lines.push(`${key}=${values[key]}`);
      seen.add(key);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  return `${lines.join("\n")}\n`;
}

async function readEnvValues() {
  try {
    return {
      ...process.env,
      ...parseEnv(await fs.readFile(envPath, "utf8"))
    };
  } catch {
    return { ...process.env };
  }
}

async function saveEbayCredentials(body) {
  const values = await readEnvValues();
  const clientId = String(body.clientId || "").trim();
  const clientSecret = String(body.clientSecret || "").trim();
  const ebayEnv = String(body.ebayEnv || "production").trim().toLowerCase();

  if (clientId) values.EBAY_CLIENT_ID = clientId;
  if (clientSecret) values.EBAY_CLIENT_SECRET = clientSecret;
  values.EBAY_ENV = ebayEnv === "sandbox" ? "sandbox" : "production";
  if (!values.PORT) values.PORT = String(port);

  await fs.writeFile(envPath, serializeEnv(values), { mode: 0o600 });
  process.env.EBAY_CLIENT_ID = values.EBAY_CLIENT_ID || "";
  process.env.EBAY_CLIENT_SECRET = values.EBAY_CLIENT_SECRET || "";
  process.env.EBAY_ENV = values.EBAY_ENV;
  process.env.PORT = values.PORT;

  return configStatus(values);
}

async function saveOpenAiCredentials(body) {
  const values = await readEnvValues();
  const apiKey = String(body.apiKey || "").trim();
  const model = String(body.model || "gpt-4.1-mini").trim();

  if (apiKey) values.OPENAI_API_KEY = apiKey;
  values.OPENAI_VISION_MODEL = model || "gpt-4.1-mini";
  if (!values.PORT) values.PORT = String(port);

  await fs.writeFile(envPath, serializeEnv(values), { mode: 0o600 });
  process.env.OPENAI_API_KEY = values.OPENAI_API_KEY || "";
  process.env.OPENAI_VISION_MODEL = values.OPENAI_VISION_MODEL || "gpt-4.1-mini";
  process.env.PORT = values.PORT;

  return configStatus(values);
}

function configStatus(values = process.env) {
  const productLookup = hasProductLookupConfig();
  return {
    ebayClientId: Boolean(values.EBAY_CLIENT_ID && !String(values.EBAY_CLIENT_ID).includes("your-")),
    ebayClientSecret: Boolean(values.EBAY_CLIENT_SECRET && !String(values.EBAY_CLIENT_SECRET).includes("your-")),
    ebayEnv: values.EBAY_ENV || "production",
    ebayMarketplaceInsights: values.EBAY_ENABLE_MARKETPLACE_INSIGHTS === "true",
    reverbToken: Boolean(values.REVERB_TOKEN && !String(values.REVERB_TOKEN).includes("your-")),
    openAiVision: Boolean(values.OPENAI_API_KEY && !String(values.OPENAI_API_KEY).includes("your-")),
    openAiVisionModel: values.OPENAI_VISION_MODEL || "gpt-4.1-mini",
    crawl4AiEnabled: values.CRAWL4AI_ENABLED !== "false",
    productLookup,
    betaAccessEnabled: Boolean(values.BETA_ACCESS_CODE && !String(values.BETA_ACCESS_CODE).includes("your-")),
    publicUrl: values.APP_PUBLIC_URL || ""
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function betaAccessCode() {
  return String(process.env.BETA_ACCESS_CODE || "").trim();
}

function betaAccessStatus() {
  return {
    enabled: Boolean(betaAccessCode())
  };
}

async function healthStatus(request) {
  const values = await readEnvValues();
  const config = configStatus(values);
  const finds = await readFinds();
  const crawl4AiReady = await hasCrawl4Ai();
  const publicUrl = config.publicUrl || "";
  const requestHost = String(request.headers.host || "");
  const runningLocal = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(requestHost);
  const checks = [
    { label: "Server", ok: true, detail: "API is responding." },
    { label: "Beta access", ok: config.betaAccessEnabled, detail: config.betaAccessEnabled ? "Beta code is configured." : "No beta code is configured." },
    { label: "eBay active comps", ok: Boolean(config.ebayClientId && config.ebayClientSecret), detail: config.ebayClientId && config.ebayClientSecret ? "eBay Browse credentials are present." : "eBay credentials are missing." },
    { label: "Photo ID", ok: config.openAiVision, detail: config.openAiVision ? `Vision model: ${config.openAiVisionModel}.` : "OpenAI Vision key is missing." },
    { label: "Barcode lookup", ok: Boolean(config.productLookup?.upcItemDb || config.productLookup?.openFacts || config.productLookup?.barcodeLookup), detail: config.productLookup?.barcodeLookup ? "Barcode Lookup key is configured; UPCitemdb and Open Facts fallbacks are available." : "UPCitemdb trial and Open Facts fallbacks are available. Add BARCODE_LOOKUP_API_KEY for broader coverage." },
    { label: "Smart page scan", ok: crawl4AiReady, detail: crawl4AiReady ? "Crawl4AI is available for Radar source pages." : "Crawl4AI not installed; Radar uses the basic scanner fallback." },
    { label: "Sold comps", ok: config.ebayMarketplaceInsights, detail: config.ebayMarketplaceInsights ? "Marketplace Insights is enabled." : "Waiting for eBay Marketplace Insights approval." },
    { label: "Public URL", ok: Boolean(publicUrl) || !runningLocal, detail: publicUrl || (runningLocal ? "Running locally; deploy before outside beta." : `Running on ${requestHost}.`) },
    { label: "Tester examples", ok: finds.length >= 5, detail: `${finds.length} saved find${finds.length === 1 ? "" : "s"} recorded.` }
  ];

  return {
    ok: checks.filter(check => check.ok).length >= 4,
    generatedAt: new Date().toISOString(),
    environment: {
      host: requestHost,
      local: runningLocal,
      publicUrl
    },
    checks
  };
}

function hasBetaAccess(request) {
  const code = betaAccessCode();
  if (!code) return true;
  return String(request.headers["x-beta-access-code"] || "").trim() === code;
}

function requireBetaAccess(request, response) {
  if (hasBetaAccess(request)) return true;
  sendJson(response, 401, { error: "Beta access code required" });
  return false;
}

function hasOpenAiVisionCredentials() {
  return Boolean(process.env.OPENAI_API_KEY && !String(process.env.OPENAI_API_KEY).includes("your-"));
}

function extractResponseText(payload) {
  if (payload?.output_text) return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function safeJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function normalizeVisionCategory(category = "") {
  const allowed = ["Vintage audio", "Books", "Pens", "Watches", "Knives", "Instruments", "Retail arbitrage", "Tools", "Cameras", "Comic books", "Sports cards", "Sports memorabilia", "Coins", "Stamps", "Art and paintings", "Vases and pottery", "Jewelry", "Mixed sale"];
  return allowed.includes(category) ? category : "Mixed sale";
}

function normalizeVisionBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  return ["true", "yes", "likely", "1"].includes(text);
}

function normalizeVisionConfidence(value, title, category) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return title && category !== "Mixed sale" ? 55 : 40;
  if (raw > 0 && raw <= 1) return Math.round(raw * 100);
  if (raw < 15 && title && category !== "Mixed sale") return 55;
  return Math.max(1, Math.min(99, Math.round(raw)));
}

function normalizeVisionText(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).join(" ").trim() || fallback;
  return String(value || fallback).replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeVisionNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const match = String(value).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function retailCategoryFromText(value) {
  const text = String(value || "").toLowerCase();
  if (/shoe|shoes|sneaker|sneakers|tennis shoe|running shoe|trainer|cleat|boot|boots|sandal|sandals|nike|adidas|new balance|asics|brooks|hoka|skechers|puma|reebok|converse|vans/.test(text)) {
    return "Retail arbitrage";
  }
  if (/apparel|clothing|shirt|pants|jacket|coat|dress|jeans|hoodie|sweater|sweatshirt|shorts|socks|hat|cap|size \d+|mens|women'?s|kids/.test(text)) {
    return "Retail arbitrage";
  }
  return "";
}

async function identifyPhoto(body) {
  const imageData = String(body.imageData || "");
  const clue = String(body.clue || "").trim();

  if (!imageData.startsWith("data:image/")) {
    return { configured: hasOpenAiVisionCredentials(), needsClue: true, message: "Attach a clear photo first." };
  }

  if (!hasOpenAiVisionCredentials()) {
    return {
      configured: false,
      needsClue: true,
      message: "AI photo identification is ready to wire, but OPENAI_API_KEY is not set yet. Type one clue for now."
    };
  }

  const model = process.env.OPENAI_VISION_MODEL && !process.env.OPENAI_VISION_MODEL.includes("your-")
    ? process.env.OPENAI_VISION_MODEL
    : "gpt-4.1-mini";
  const prompt = [
    "You are identifying estate sale and resale finds for The Great Hunt.",
    "Return only JSON with keys: title, category, searchTerms, visibleClues, conditionClues, lowValueSignal, valueSignal, confidence, warning.",
    "category must be one of: Vintage audio, Books, Pens, Watches, Knives, Instruments, Retail arbitrage, Tools, Cameras, Comic books, Sports cards, Sports memorabilia, Coins, Stamps, Art and paintings, Vases and pottery, Jewelry, Mixed sale.",
    "Be conservative. If the item looks like a common disposable object, set lowValueSignal true unless there is visible scarcity.",
    clue ? `User clue: ${clue}` : "No user clue was provided."
  ].join(" ");

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageData, detail: "low" }
        ]
      }]
    })
  });

  if (!apiResponse.ok) {
    const text = await apiResponse.text();
    return {
      configured: true,
      needsClue: true,
      message: `Photo identification did not complete (${apiResponse.status}). Type one clue for now.`,
      detail: text.slice(0, 240)
    };
  }

  const payload = await apiResponse.json();
  const parsed = safeJsonFromText(extractResponseText(payload));
  if (!parsed) {
    return { configured: true, needsClue: true, message: "Photo identification came back unclear. Type one clue for now." };
  }

  const title = normalizeVisionText(parsed.title, normalizeVisionText(parsed.searchTerms, clue || "Unknown item"));
  const searchTerms = normalizeVisionText(parsed.searchTerms, title);
  const category = retailCategoryFromText(`${title} ${searchTerms} ${clue}`) || normalizeVisionCategory(parsed.category);
  const lowValueSignal = normalizeVisionBoolean(parsed.lowValueSignal) || everydayItemSignal(`${title} ${searchTerms}`);
  const valueSignal = typeof parsed.valueSignal === "string" && !["true", "false"].includes(parsed.valueSignal.trim().toLowerCase())
    ? parsed.valueSignal
    : lowValueSignal
      ? "No obvious resale signal."
      : "Possible resale item; verify exact identity.";

  return {
    configured: true,
    needsClue: false,
    title,
    category,
    searchTerms,
    visibleClues: Array.isArray(parsed.visibleClues) ? parsed.visibleClues.slice(0, 5) : [],
    conditionClues: Array.isArray(parsed.conditionClues) ? parsed.conditionClues.slice(0, 5) : [],
    lowValueSignal,
    valueSignal,
    confidence: normalizeVisionConfidence(parsed.confidence, title, category),
    warning: String(parsed.warning || "Verify exact model, authenticity, and condition before relying on the comps.")
  };
}

async function scanClearanceTag(body) {
  const imageData = String(body.imageData || "");

  if (!imageData.startsWith("data:image/")) {
    return { configured: hasOpenAiVisionCredentials(), needsClue: true, message: "Take a clear photo of the clearance tag first." };
  }

  if (!hasOpenAiVisionCredentials()) {
    return {
      configured: false,
      needsClue: true,
      message: "Clearance tag reading needs the OpenAI Vision key. For now, type the item and clearance price."
    };
  }

  const model = process.env.OPENAI_VISION_MODEL && !process.env.OPENAI_VISION_MODEL.includes("your-")
    ? process.env.OPENAI_VISION_MODEL
    : "gpt-4.1-mini";
  const prompt = [
    "You read retail clearance tags, shelf labels, package labels, and barcodes for The Great Hunt.",
    "The image may be rotated, upside down, cropped, or show only a barcode/product label with no price.",
    "Return only JSON with keys: labelType, store, productTitle, brand, clearancePrice, originalPrice, percentOff, upc, sku, styleNumber, sizeColor, visibleText, condition, confidence, warning.",
    "Read visible text from tags from stores like Target, TJ Maxx, Marshalls, Ross, HomeGoods, Walmart, Costco, Sam's Club, Lowe's, Home Depot, Ollie's, and closeout aisles.",
    "If you see a barcode, transcribe the UPC/EAN digits exactly as printed, including leading or trailing check digits. If a number is unclear, use 0 for prices and an empty string for identifiers.",
    "Set labelType to clearance tag, shelf tag, barcode label, package label, or unknown. Keep productTitle short but searchable. Set condition to sealed, open box, damaged package, return sticker, or unknown."
  ].join(" ");

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageData, detail: "high" }
        ]
      }]
    })
  });

  if (!apiResponse.ok) {
    const text = await apiResponse.text();
    return {
      configured: true,
      needsClue: true,
      message: `Clearance tag scan did not complete (${apiResponse.status}). Type the item and price for now.`,
      detail: text.slice(0, 240)
    };
  }

  const payload = await apiResponse.json();
  const parsed = safeJsonFromText(extractResponseText(payload));
  if (!parsed) {
    return { configured: true, needsClue: true, message: "The tag photo came back unclear. Try a closer photo or type the item and price." };
  }

  const visibleText = normalizeVisionText(parsed.visibleText, "");
  const labelType = normalizeVisionText(parsed.labelType, "");
  const productTitle = normalizeVisionText(parsed.productTitle, normalizeVisionText(visibleText, normalizeVisionText(parsed.brand, "Scanned retail item")));
  const brand = normalizeVisionText(parsed.brand, "");
  const upc = normalizeVisionText(parsed.upc, "");
  const sku = normalizeVisionText(parsed.sku, "");
  const styleNumber = normalizeVisionText(parsed.styleNumber, "");
  const productLookup = await lookupProductByBarcode(upc || sku || styleNumber);
  const resolvedTitle = productLookup?.title || productTitle;
  const resolvedBrand = productLookup?.brand || brand;
  const searchTerms = normalizeWhitespace([resolvedBrand, resolvedTitle, productLookup?.barcode || upc, sku, styleNumber].filter(Boolean).join(" "));
  const clearancePrice = normalizeVisionNumber(parsed.clearancePrice);
  const originalPrice = normalizeVisionNumber(parsed.originalPrice);
  const percentOff = normalizeVisionNumber(parsed.percentOff) || (clearancePrice && originalPrice ? Math.round((1 - clearancePrice / originalPrice) * 100) : 0);
  const missingPriceWarning = clearancePrice
    ? ""
    : " No price was visible, so enter the shelf/clearance price before trusting the spread math.";

  return {
    configured: true,
    needsClue: false,
    labelType,
    category: "Retail arbitrage",
    store: normalizeVisionText(parsed.store, "Unknown store"),
    productTitle: resolvedTitle,
    brand: resolvedBrand,
    searchTerms: searchTerms || resolvedTitle,
    clearancePrice,
    originalPrice,
    percentOff,
    upc: productLookup?.barcode || upc,
    sku,
    styleNumber,
    sizeColor: normalizeVisionText(parsed.sizeColor, ""),
    visibleText,
    productLookup: productLookup
      ? {
        source: productLookup.source,
        title: productLookup.title,
        brand: productLookup.brand,
        barcode: productLookup.barcode,
        image: productLookup.image,
        lowestPrice: productLookup.lowestPrice,
        highestPrice: productLookup.highestPrice,
        offers: productLookup.offers || []
      }
      : null,
    condition: normalizeVisionText(parsed.condition, "unknown"),
    confidence: productLookup ? Math.max(72, normalizeVisionConfidence(parsed.confidence, resolvedTitle, "Retail arbitrage")) : normalizeVisionConfidence(parsed.confidence, resolvedTitle, "Retail arbitrage"),
    warning: `${productLookup ? `Product lookup matched ${productLookup.source}. ` : ""}${normalizeVisionText(parsed.warning, "Verify the UPC/SKU and package condition before relying on the comps.")}${missingPriceWarning}`.trim()
  };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(root, requestedPath));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/beta/status") {
      sendJson(response, 200, betaAccessStatus());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, await healthStatus(request));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/beta/access") {
      const body = await readJsonBody(request);
      const submittedCode = String(body.code || "").trim();
      const configuredCode = betaAccessCode();
      const accepted = !configuredCode || submittedCode.toUpperCase() === configuredCode.toUpperCase();
      sendJson(response, accepted ? 200 : 401, { accepted, enabled: Boolean(betaAccessCode()) });
      return;
    }

    if (url.pathname.startsWith("/api/") && !requireBetaAccess(request, response)) {
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/photo/identify") {
      sendJson(response, 200, await identifyPhoto(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/clearance/scan") {
      sendJson(response, 200, await scanClearanceTag(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/lookup") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await buildLookupDeal(body));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/deals") {
      sendJson(response, 200, await buildLiveDeals());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/radar/scan") {
      sendJson(response, 200, await buildRadarScan(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config/status") {
      sendJson(response, 200, configStatus(await readEnvValues()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/config/ebay") {
      sendJson(response, 200, await saveEbayCredentials(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/config/openai") {
      sendJson(response, 200, await saveOpenAiCredentials(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/watchlists") {
      sendJson(response, 200, await readWatchlists());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/finds") {
      sendJson(response, 200, await readFinds());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/finds") {
      const finds = await readFinds();
      const body = await readJsonBody(request);
      const nextId = Math.max(0, ...finds.map(find => Number(find.id) || 0)) + 1;
      const savedFind = {
        id: nextId,
        savedAt: new Date().toISOString(),
        title: String(body.title || "Untitled find"),
        category: String(body.category || "Unknown"),
        ground: String(body.ground || "Unknown"),
        condition: String(body.condition || "Clean"),
        conditionKey: String(body.conditionKey || "clean"),
        conditionNote: String(body.conditionNote || ""),
        conditionHints: Array.isArray(body.conditionHints) ? body.conditionHints.slice(0, 6) : [],
        source: String(body.source || "Unknown source"),
        ask: Number(body.ask || 0),
        fastSale: Number(body.fastSale || 0),
        comps: Number(body.comps || 0),
        compRange: String(body.compRange || ""),
        confidence: Number(body.confidence || 0),
        distance: Number(body.distance || 0),
        explanation: String(body.explanation || ""),
        compLinks: Array.isArray(body.compLinks) ? body.compLinks.slice(0, 6) : [],
        compReview: body.compReview && typeof body.compReview === "object" ? body.compReview : null,
        betaStatus: String(body.betaStatus || "interested"),
        betaNotes: String(body.betaNotes || ""),
        betaFeedback: String(body.betaFeedback || "")
      };

      await writeFinds([savedFind, ...finds]);
      sendJson(response, 201, savedFind);
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/finds/")) {
      const id = Number(url.pathname.split("/").pop());
      const finds = await readFinds();
      const body = await readJsonBody(request);
      const index = finds.findIndex(find => Number(find.id) === id);

      if (index === -1) {
        sendJson(response, 404, { error: "Find not found" });
        return;
      }

      const updatedFind = {
        ...finds[index],
        betaStatus: String(body.betaStatus || finds[index].betaStatus || "interested"),
        betaNotes: String(body.betaNotes ?? finds[index].betaNotes ?? ""),
        betaFeedback: String(body.betaFeedback || finds[index].betaFeedback || ""),
        updatedAt: new Date().toISOString()
      };

      finds[index] = updatedFind;
      await writeFinds(finds);
      sendJson(response, 200, updatedFind);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/watchlists") {
      const watchlists = await readWatchlists();
      const body = await readJsonBody(request);
      const nextId = Math.max(0, ...watchlists.map(rule => Number(rule.id) || 0)) + 1;
      const newRule = {
        id: nextId,
        name: String(body.name || "Untitled alert"),
        keyword: String(body.keyword || ""),
        ground: String(body.ground || "Any"),
        profit: Number(body.profit || 0),
        radius: Number(body.radius || 1)
      };

      await writeWatchlists([newRule, ...watchlists]);
      sendJson(response, 201, newRule);
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/watchlists/")) {
      const id = Number(url.pathname.split("/").pop());
      const watchlists = await readWatchlists();
      await writeWatchlists(watchlists.filter(rule => Number(rule.id) !== id));
      sendJson(response, 200, { ok: true });
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`The Great Hunt is live at http://${displayHost}:${port}`);
});

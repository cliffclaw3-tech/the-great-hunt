require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { searchEbay, searchEbaySold, hasCredentials: hasEbayCredentials } = require("./providers/ebay");
const { searchReverb, hasCredentials: hasReverbCredentials } = require("./providers/reverb");
const { searchSoldComps, hasCredentials: hasSoldCompsCredentials } = require("./providers/soldComps");
const { lookupPriceCharting, hasCredentials: hasPriceChartingCredentials } = require("./providers/priceCharting");
const { crawlUrl, hasCrawl4Ai } = require("./providers/crawl4ai");
const { lookupProductByBarcode, hasProductLookupConfig } = require("./providers/productLookup");

const root = __dirname;
const dataPath = path.join(root, "data", "watchlists.json");
const findsPath = path.join(root, "data", "finds.json");
const betaTestersPath = path.join(root, "data", "beta-testers.json");
const photoEventsPath = path.join(root, "data", "photo-events.json");
const activityEventsPath = path.join(root, "data", "activity-events.json");
const betaScoutPath = path.join(root, "data", "beta-scout.json");
const reliabilityReportPath = path.join(root, "data", "reliability-report.json");
const envPath = path.join(root, ".env");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
let pgPool = null;
let activityTableReady = false;
let betaTestersTableReady = false;

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
          : ["Comic books", "Sports cards", "Sports memorabilia", "Coins", "Stamps", "Art and paintings", "Vases and pottery", "Jewelry", "Lighting", "Furniture", "Toys"].includes(category)
            ? 2.2
            : 1.68;
}

function categoryFallbackValue(category, item = "") {
  const text = String(item || "").toLowerCase();
  const map = {
    Watches: 140,
    Books: 45,
    Pens: 55,
    "Vintage audio": 160,
    Instruments: 150,
    Knives: 45,
    Tools: 35,
    Cameras: 75,
    "Retail arbitrage": 28,
    "Comic books": 35,
    "Sports cards": 25,
    "Sports memorabilia": 50,
    Coins: 30,
    Stamps: 20,
    "Art and paintings": 85,
    "Vases and pottery": 55,
    Jewelry: 75,
    Lighting: 60,
    Furniture: 90,
    Toys: 35,
    "Mixed sale": 35
  };
  let value = map[category] || 35;
  if (/\b(rolex|omega|cartier|tiffany|leica|gibson|fender|marantz|sansui|montblanc)\b/.test(text)) value *= 1.8;
  if (/\b(signed|autograph|sterling|silver|gold|14k|18k|first edition|sealed|new in box|cgc|psa|ngc|pcgs)\b/.test(text)) value *= 1.45;
  if (/\b(broken|parts|damaged|untested|cracked|missing)\b/.test(text)) value *= 0.55;
  return Math.max(8, Math.round(value));
}

function valuationFloor(category) {
  const floors = {
    Watches: 10,
    Pens: 8,
    "Vintage audio": 10,
    "Retail arbitrage": 15,
    Cameras: 8,
    Tools: 5,
    Instruments: 25,
    Books: 5,
    "Sports cards": 3,
    "Comic books": 2,
    Coins: 3,
    "Vases and pottery": 5,
    Jewelry: 3,
    Lighting: 5,
    Furniture: 5,
    Toys: 5
  };
  return floors[category] || 0;
}

function valuationSearchQueries(item, category) {
  const raw = normalizeWhitespace(item);
  const cleaned = cleanForSaleQuery(raw, category);
  const tokens = tokenizeText(cleaned)
    .filter(token => !["vintage", "antique", "old", "rare", "estate", "sale", "with", "the", "and"].includes(token));
  const compact = tokens.slice(0, 8).join(" ");
  const brandModel = tokens
    .filter(token => token.length > 2 || /\d/.test(token))
    .slice(0, 5)
    .join(" ");

  const alternates = [];
  if (category === "Vases and pottery" && /\bfiestaware\b/i.test(raw)) {
    alternates.push(raw.replace(/\bfiestaware\b/gi, "Fiesta"));
  }
  if (category === "Comic books" && /\bspawn\s*1\b/i.test(raw) && !/\b1992\b/.test(raw)) {
    alternates.push(`${raw} 1992`);
  }
  if (category === "Books") {
    if (/\bfirst edition\b/i.test(raw)) alternates.push(raw.replace(/\bfirst edition\b/gi, "1st edition"));
    if (/\bdust jacket\b/i.test(raw)) alternates.push(raw.replace(/\bdust jacket\b/gi, "DJ"));
    if (/\bhobbit\b/i.test(raw) && /\btolkien\b/i.test(raw)) {
      alternates.push("The Hobbit Tolkien hardcover dust jacket");
      alternates.push("The Hobbit Tolkien Houghton Mifflin hardcover");
    }
  }

  return [...new Set([raw, cleaned, compact, brandModel, ...alternates].map(normalizeWhitespace).filter(Boolean))].slice(0, 5);
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
    Lighting: ["Maker mark or label", "Shade and finial completeness", "Working wiring and socket safety", "Material, height, and pair/set status"],
    Furniture: ["Maker mark or label", "Dimensions and wood/material", "Structural damage, veneer, and repairs", "Original hardware and finish"],
    Toys: ["Exact set, character, or model number", "Completeness and accessories", "Box, instructions, and sealed status", "Age, series, variant, and condition"],
    Pens: ["Nib imprint and size", "Filling system condition", "Cracks, shrinkage, and cap fit", "Restoration needs"],
    "Vintage audio": ["Both channels tested", "Faceplate and knob condition", "Recap/service history", "Scratchy controls or hum"],
    "Retail arbitrage": ["Exact SKU/UPC", "Sealed box and return stickers", "Discontinued color or variant", "Shipping and return risk"],
    Tools: ["Exact model number", "Battery platform and voltage", "Tool-only vs kit", "Battery, charger, case, and function test"],
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
    "newspaper clipping",
    "ikea billy bookcase",
    "ikea bookcase",
    "particle board bookcase",
    "ikea floor lamp"
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

function accessoryOnlyReason(item, category = "") {
  const text = String(item || "").toLowerCase();
  const rules = [
    {
      categories: ["Watches"],
      pattern: /\b(watch\s+)?(band|strap|bracelet|bracelet only|rubber band|clasp|crown|caseback|case back|bezel insert|dial only|hands only|movement only|watch box|box for rolex|rolex box)\b|\bonly\b/,
      reason: "This looks like a watch part or accessory, not the full watch."
    },
    {
      categories: ["Vintage audio"],
      pattern: /\b(faceplate|face plate|knob|dial glass|manual only|remote only|board|recap kit|capacitor kit|parts?|repair)\b/,
      reason: "This looks like an audio part or repair item, not the full component."
    },
    {
      categories: ["Toys"],
      pattern: /\b(box only|empty box|manual only|instructions? only|replacement parts?|light kit|display stand|accessor(?:y|ies) only)\b/,
      reason: "This looks like toy packaging, instructions, or an accessory, not the complete toy."
    },
    {
      categories: ["Cameras"],
      pattern: /\b(body cap|lens cap|cap only|strap|manual only|case only|battery only|charger only|filter kit|adapter|mount only|housing only)\b/,
      reason: "This looks like a camera accessory, not the camera or lens itself."
    },
    {
      categories: ["Tools"],
      pattern: /\b(case only|battery only|charger only|bare battery|battery pack|manual|parts?|repair|test leads?|leads? for|probe set|probes? for)\b/,
      reason: "This looks like a tool accessory, battery, case, or repair item, not the tool itself."
    },
    {
      categories: ["Lighting"],
      pattern: /\b(lamp shade only|shade only|replacement shade|finials?|lamp base|base only|socket only|cord only|harp only|lamp parts?|bulb only|repair kit)\b/,
      reason: "This looks like a lamp part or accessory, not the complete lamp."
    },
    {
      categories: ["Furniture"],
      pattern: /\b(cedar chest key|key only|drawer pull|pulls only|knob only|hardware only|replacement leg|slipcover|cover only|cushion only|mini cedar|miniature cedar|keepsake chest|trinket box|jewelry box|salesman sample|salesmans sample)\b/,
      reason: "This looks like furniture hardware, a miniature, or an accessory, not the full furniture item."
    },
    {
      categories: ["Pens"],
      pattern: /\b(pencil set|mechanical pencil|pencil only|nib only|nib unit|cap only|converter|refill|cartridge|empty box|clip only)\b/,
      reason: "This looks like a pen accessory or different writing instrument, not the requested pen."
    },
    {
      categories: ["Instruments"],
      pattern: /\b(guitar case only|case only|strap locks?|guitar strap|strings? only|pickup only|pickguard|neck only|body only|bridge pins?|tuners? only)\b/,
      reason: "This looks like an instrument accessory or part, not the full instrument."
    },
    {
      categories: ["Knives"],
      pattern: /\b(sheath only|knife sheath|blade only|handle scales?|clip only)\b/,
      reason: "This looks like a knife accessory or part, not the full knife."
    },
    {
      categories: ["Jewelry"],
      pattern: /\btiffany style\b|\bcartier style\b|\bvan cleef style\b/,
      reason: "This uses premium-brand style wording, not proof of the branded jewelry item."
    },
    {
      categories: ["Retail arbitrage"],
      pattern: /\b(lid only|replacement lid|case only|battery only|charger only|bare battery|battery pack|manual|parts?|repair)\b/,
      reason: "This looks like a replacement part or accessory, not the complete retail item."
    },
    {
      categories: ["Sports cards", "Comic books", "Coins", "Watches"],
      pattern: /\b(proxy|replica|reprint|facsimile|homage|commemorative|novelty)\b/,
      reason: "This looks like a replica, reprint, homage, or novelty item; do not price it against originals."
    }
  ];
  return rules.find(rule => rule.categories.includes(category) && rule.pattern.test(text))?.reason || "";
}

function insufficientIdentifierReason(item, category = "") {
  const text = String(item || "").toLowerCase().trim();
  if (category === "Watches") {
    const hasWatchIdentifier = /\b(rolex|omega|seiko|casio|tag heuer|tudor|cartier|breitling|hamilton|longines|citizen|submariner|seamaster|speedmaster|datejust|daytona|g-shock|skx|reference|ref\.?|model|\d{3,})\b/.test(text);
    if (!hasWatchIdentifier && /\b(watch|wristwatch|old watch|vintage watch)\b/.test(text)) {
      return "Watch pricing needs at least a brand, model, reference number, or clear dial/case clue.";
    }
  }

  return "";
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
    Lighting: "Lamp value depends on maker, material, shade, working wiring, pair status, and whether the style is truly period or just inspired.",
    Furniture: "Furniture value lives in maker, material, dimensions, joinery, original finish, and whether shipping or local pickup limits the buyer pool.",
    Toys: "Toy value often hides in exact set numbers, discontinued characters, early releases, sealed packaging, complete accessories, and collector variants.",
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
  return ["Comic books", "Sports cards", "Sports memorabilia", "Coins", "Stamps", "Art and paintings", "Vases and pottery", "Jewelry", "Lighting", "Furniture", "Toys"].includes(category);
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
  if (category === "Lighting") {
    return [
      [`eBay sold lighting: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Sold=1&LH_Complete=1`],
      [`WorthPoint lighting: ${item}`, `https://www.worthpoint.com/inventory/search?query=${encoded}`],
      [`LiveAuctioneers lighting: ${item}`, `https://www.liveauctioneers.com/search/?keyword=${encoded}`]
    ];
  }
  if (category === "Furniture") {
    return [
      [`eBay sold furniture: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Sold=1&LH_Complete=1`],
      [`WorthPoint furniture: ${item}`, `https://www.worthpoint.com/inventory/search?query=${encoded}`],
      [`LiveAuctioneers furniture: ${item}`, `https://www.liveauctioneers.com/search/?keyword=${encoded}`]
    ];
  }
  if (category === "Toys") {
    return [
      [`eBay sold toys: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Sold=1&LH_Complete=1`],
      [`WorthPoint toys: ${item}`, `https://www.worthpoint.com/inventory/search?query=${encoded}`],
      [`Mercari toys: ${item}`, `https://www.mercari.com/search/?keyword=${encoded}`]
    ];
  }
  return [];
}

function valuationProofFor(category, item = "") {
  const text = String(item || "").toLowerCase();
  const common = {
    label: "Needs more proof",
    action: "Add one close-up of the identifier and one full-item photo.",
    missing: ["Exact maker/model or identifier", "Condition proof", "A same-item sold comp"]
  };

  if (category === "Sports cards") {
    const missing = [];
    if (!/\b(18|19|20)\d{2}\b|t206|topps|bowman|panini|fleer|donruss|upper deck|prizm|select|optic/.test(text)) missing.push("Year and set/brand");
    if (!/#\s*[a-z0-9-]+|\bcard\s*#|\bno\.\s*[a-z0-9-]+/.test(text)) missing.push("Card number or back photo");
    if (!/\bpsa\b|\bsgc\b|\bbgs\b|beckett|raw|graded|\b\d(?:\.\d)?\b/.test(text)) missing.push("Raw vs graded status");
    return {
      label: "Card not valued yet",
      action: "Photograph the front, back, and any grading slab label. The back usually carries the card number.",
      missing: missing.length ? missing : ["Same grade sold comps", "Authentication or slab serial check", "Condition match"]
    };
  }

  if (category === "Coins") {
    const missing = [];
    if (!/\b(17|18|19|20)\d{2}\b/.test(text)) missing.push("Year");
    if (!/\bmint mark\b|\b[spdo]\b|san francisco|denver|philadelphia|carson city|new orleans/.test(text)) missing.push("Mint mark");
    if (!/pcgs|ngc|anacs|graded|ms\d+|pr\d+|vf|xf|au|unc|fine|good/.test(text)) missing.push("Grade or clear condition tier");
    return {
      label: "Coin not valued yet",
      action: "Photograph both sides, the rim, and any slab label. The reverse can decide the variety.",
      missing: missing.length ? missing : ["Variety or error proof", "Same grade sold comps", "Cleaning/damage check"]
    };
  }

  if (category === "Books") {
    const missing = [];
    if (!/\b(first edition|1st edition|first printing|1st printing|impression|printing)\b/.test(text)) missing.push("Edition, printing, or impression");
    if (!/\bdust jacket\b|\bdj\b|\bjacket\b/.test(text)) missing.push("Dust jacket state");
    if (!/\b(title page|copyright page|publisher|houghton|unwin|allen)\b/.test(text)) missing.push("Title/copyright page proof");
    return {
      label: "Collector proof needed",
      action: "Photograph the cover, dust jacket, title page, copyright page, publisher line, and any issue points before trusting a value.",
      missing: missing.length ? missing : ["Same printing sold comps", "Dust jacket issue points", "Condition and restoration check"]
    };
  }

  if (category === "Tools") {
    const missing = [];
    if (!/\b[a-z]{2,}\d{3,}\b|\bmodel\b|\btype\b/.test(text)) missing.push("Exact model number");
    if (!/\b12v\b|\b18v\b|\b20v\b|\b40v\b|\b60v\b|\bm12\b|\bm18\b/.test(text)) missing.push("Battery platform or voltage");
    if (!/\b(tool only|bare tool|battery|charger|kit|case)\b/.test(text)) missing.push("Tool-only vs battery/charger kit");
    return {
      label: "Tool proof needed",
      action: "Photograph the model plate, battery platform, charger/battery/case, and a quick power test before trusting the value.",
      missing: missing.length ? missing : ["Function test", "Battery health", "Included accessories"]
    };
  }

  if (category === "Jewelry") {
    return {
      label: "Jewelry not valued yet",
      action: "Photograph hallmarks, clasp, stones, and the whole piece; add weight and metal mark if known.",
      missing: ["Metal/karat mark", "Stone identity", "Weight or maker mark"]
    };
  }

  if (category === "Art and paintings") {
    return {
      label: "Art not valued yet",
      action: "Photograph the front, back, signature, labels, and size before relying on a value.",
      missing: ["Artist identity", "Medium and size", "Provenance or auction history"]
    };
  }

  if (category === "Vases and pottery") {
    return {
      label: "Pottery not valued yet",
      action: "Photograph the full piece, bottom mark, rim, and any chips or repairs.",
      missing: ["Maker/bottom mark", "Size and shape", "Damage/repair proof"]
    };
  }

  if (category === "Lighting") {
    return {
      label: "Lighting proof needed",
      action: "Photograph the maker label, socket, plug, shade, finial, full height, and any matching pair before trusting a value.",
      missing: ["Maker/label", "Working wiring and socket", "Shade/pair completeness"]
    };
  }

  if (category === "Furniture") {
    return {
      label: "Furniture proof needed",
      action: "Photograph maker marks, dimensions, joints, hardware, finish, underside/back, and any damage before trusting a value.",
      missing: ["Maker/label", "Dimensions and material", "Structural or finish condition"]
    };
  }
  if (category === "Toys") {
    return {
      label: "Toy proof needed",
      action: "Photograph the set number, box barcode, character marks, accessories, instructions, and all missing or damaged pieces.",
      missing: ["Exact set/model or character", "Completeness", "Box/sealed status and condition"]
    };
  }

  return common;
}

function nextResearchStepsFor(category) {
  const map = {
    "Sports cards": [
      "Photograph the front, back, and any PSA/SGC/BGS slab label.",
      "Add year, set/brand, card number, player, grade, rookie/parallel/autograph, and serial number if present.",
      "Compare only sold cards with the same set, number, and grade."
    ],
    Coins: [
      "Photograph both sides, the rim, and any PCGS/NGC/ANACS slab label.",
      "Add year, mint mark, denomination, variety/error, metal, and a clear condition tier.",
      "Compare only same-date, same-mint, same-grade sold examples."
    ],
    Jewelry: [
      "Photograph hallmarks, clasp, stones, and the whole piece.",
      "Add metal mark, karat, maker, stone type, and weight if known.",
      "Use a jeweler or appraisal before trusting any high-dollar value."
    ],
    "Art and paintings": [
      "Photograph the front, back, signature, frame, labels, and measurements.",
      "Add artist, title, medium, size, provenance, and any gallery or auction labels.",
      "Compare only confirmed original works, not prints or decorative copies."
    ],
    "Vases and pottery": [
      "Photograph the full piece, bottom mark, rim, base, and damage.",
      "Add height, material, country, pattern, glaze, and maker mark if visible.",
      "Compare only the same maker, shape, size, period, and condition."
    ],
    Lighting: [
      "Photograph the full lamp, maker label, socket, plug, shade, finial, and underside.",
      "Add height, material, working status, shade condition, and whether it is one lamp or a pair.",
      "Compare only similar maker/style/material and account for rewiring or missing shade."
    ],
    Furniture: [
      "Photograph the full piece, maker label, underside/back, joints, hardware, and damage.",
      "Add dimensions, material, finish, drawer/door function, and local pickup constraints.",
      "Compare only similar size, maker/style, material, and condition; shipping-heavy comps can mislead."
    ],
    Toys: [
      "Find the exact set number, character name, release year, or model stamped on the toy or box.",
      "Count accessories, minifigures, clothing, manuals, inserts, and missing pieces.",
      "Compare sealed, boxed, complete loose, and incomplete loose examples separately."
    ],
    Books: [
      "Photograph the cover, dust jacket, title page, copyright page, and publisher line.",
      "Add edition, printing/impression, publisher, jacket condition, and known issue points.",
      "Compare only the same printing and jacket state; facsimiles and later printings do not count."
    ],
    Tools: [
      "Photograph the model plate, battery platform, and serial/type label.",
      "Add whether it is tool-only, includes batteries, charger, case, bits, or blades.",
      "Compare only the same model and battery platform; bare tools and full kits price differently."
    ]
  };

  return map[category] || [
    "Add a brand, model number, maker mark, UPC, signature, year, size, or material from the item.",
    "Open the research links and compare only items with the same identifiers and condition.",
    "If the result is still broad, take a closer photo of labels, bottom marks, tags, serial plates, or packaging."
  ];
}

function buildFallbackDeal(input, reason = "Using local estimate fallback.") {
  const item = String(input.item || "Untitled item").trim();
  const category = String(input.category || "").trim() || inferCategoryFromItem(item) || "Vintage audio";
  const ground = String(input.ground || input.source || "Estate sale");
  const ask = Number(input.ask || 0);
  const distance = Number(input.distance || 0);
  const condition = String(input.condition || "clean");
  const multiplier = categoryMultiplier(category);
  const missingAsk = ask <= 0;
  const fallbackValue = categoryFallbackValue(category, item);
  const highRange = ask * (multiplier + 0.55);
  const collectibleLinks = collectibleReferenceLinks(item, category);
  const collectibleNote = isCollectibleCategory(category)
    ? " Expert-check mode: exact identifiers, marks, maker, artist, grade, appraisal, provenance, and authentication can change value dramatically."
    : "";
  const checkedSources = [
    hasSoldCompsCredentials() ? "SoldComps sold API" : "",
    process.env.EBAY_ENABLE_MARKETPLACE_INSIGHTS === "true" ? "eBay Marketplace Insights sold API" : "",
    hasEbayCredentials() ? "eBay Browse active listings" : "",
    ["Vintage audio", "Instruments"].includes(category) && hasReverbCredentials() ? "Reverb listings" : ""
  ].filter(Boolean);

  return applyConditionToDeal({
    title: item,
    category,
    ground,
    source: "Local fallback estimate",
    valuationStatus: "baseline",
    valuationMethod: "category-baseline",
    researchMode: true,
    checkedSources,
    valuationProof: valuationProofFor(category, item),
    ask,
    fastSale: missingAsk ? fallbackValue : Math.max(ask + 20, ask * multiplier),
    allowBelowAsk: missingAsk,
    comps: missingAsk || isCollectibleCategory(category) ? 0 : category === "Vintage audio" ? 4 : 6,
    compRange: missingAsk ? `${money(fallbackValue * 0.65)}-${money(fallbackValue * 1.35)}` : `${money(ask * 1.45)}-${money(highRange)}`,
    absorption: multiplier > 2 ? "hot" : "steady",
    distance,
    confidence: missingAsk ? 38 : isCollectibleCategory(category) ? 48 : category === "Vintage audio" ? 69 : 74,
    photo: fallbackPhoto(category, item),
    compLinks: [
      ...collectibleLinks,
      [`eBay sold: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item)}&LH_Sold=1&LH_Complete=1`],
      [`eBay active: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item)}`],
      [`WorthPoint archive: ${item}`, `https://www.worthpoint.com/inventory/search?query=${encodeURIComponent(item)}`],
      [`Google web: ${item}`, `https://www.google.com/search?q=${encodeURIComponent(item)}`],
      [`Google Shopping: ${item}`, `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(item)}`]
    ],
    rareFact: rareFactFor(category, item),
    nextResearchSteps: nextResearchStepsFor(category),
    checklist: isCollectibleCategory(category)
      ? ["Find exact identifiers, marks, maker, artist, grade, or appraisal clues", "Do not compare raw or unverified items to authenticated, graded, or appraised examples", "Use a local expert before paying real money"]
      : ["Match exact model, SKU, or reference", "Confirm condition tier manually", "Check fees, repairs, and haul-away friction before payment"],
    explanation: missingAsk
      ? `${reason} No seller ask was entered and live comps were unavailable, so this is a low-confidence category baseline, not an appraisal. Add the seller ask, exact model, or a clearer maker/model photo before trusting the number.`
      : `${reason}${collectibleNote}`,
    disclaimer: "Starter estimate used because accepted valuation comps were unavailable."
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

function minimumAcceptedCompsFor(category) {
  const minimums = {
    "Sports cards": 3,
    "Comic books": 2,
    Watches: 3,
    Coins: 3,
    "Vintage audio": 3,
    Instruments: 3
  };
  return minimums[category] || 2;
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

function normalizeCardText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/#/g, " #")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCardTraits(value) {
  const text = normalizeCardText(value);
  const tokens = tokenizeText(text);
  const tokenSet = new Set(tokens);
  const years = [...new Set((text.match(/\b(?:19[5-9]\d|20[0-3]\d)(?:[-/]\d{2})?\b/g) || []))];
  const cardNumbers = [...new Set((text.match(/(?:#|card\s*(?:no\.?|number)?\s*)([a-z0-9-]{1,8})/gi) || [])
    .map(match => match.replace(/card\s*(?:no\.?|number)?/i, "").replace("#", "").trim().toLowerCase())
    .filter(Boolean))];
  const graders = ["psa", "sgc", "bgs", "bvg", "beckett", "cgc"].filter(term => tokenSet.has(term));
  const gradeMatch = text.match(/\b(?:psa|sgc|bgs|bvg|beckett|cgc)?\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b/);
  const grade = graders.length && gradeMatch ? gradeMatch[1] : "";
  const brands = ["topps", "bowman", "panini", "donruss", "fleer", "upper", "deck", "score", "leaf", "select", "optic", "prizm", "finest", "chrome", "heritage", "mosaic", "pokemon", "pokémon", "base", "wizards"].filter(term => tokenSet.has(term));
  const premiumTraits = ["rookie", "rc", "auto", "autograph", "signed", "refractor", "parallel", "prizm", "xfractor", "numbered", "serial", "patch", "jersey", "relic"].filter(term => tokenSet.has(term));
  const highEndSignals = /\b(?:psa|sgc|bgs|beckett|cgc|gem mint|auto|autograph|signed|refractor|parallel|prizm|silver|gold|black|blue|red|green|orange|xfractor|numbered|serial|patch|jersey|relic)\b/;
  const genericWords = new Set(["card", "cards", "sports", "baseball", "basketball", "football", "hockey", "rookie", "rc", "the", "and", "with", "lot", "set", "topps", "bowman", "panini", "donruss", "fleer", "upper", "deck", "score", "leaf", "select", "optic", "prizm", "chrome", "heritage", "mosaic", "pokemon", "pokémon", "base", "wizards"]);
  const playerTokens = tokens
    .filter(token => token.length > 2 && !genericWords.has(token) && !/^\d+$/.test(token))
    .filter((token, index, array) => array.indexOf(token) === index)
    .slice(0, 5);

  return {
    text,
    tokens,
    tokenSet,
    years,
    cardNumbers,
    graders,
    grade,
    brands,
    premiumTraits,
    hasHighEndSignal: highEndSignals.test(text),
    playerTokens
  };
}

function sportsCardCompQualityReason({ result, item }) {
  const query = extractCardTraits(item);
  const title = extractCardTraits(result.title || "");
  const queryIsReprint = /\b(reprint|commemorative|tribute|porcelain|insert|foil|chrome|finest|archives|refractor)\b/.test(query.text);
  const titleIsReprint = /\b(reprint|commemorative|tribute|porcelain|insert|foil|chrome|finest|archives|facsimile|novelty)\b/.test(title.text);

  if (/\b(lot|lots|bundle|collection|pick your card|you pick|choose your card|complete set|team set|break|vending machine)\b|\b\d+\+?\s*(?:cards|card lot|card collection)\b|\b\d{4}\s+and\s+\d{4}\b/.test(title.text)) {
    return "Sports-card lot or pick listing, not one exact card";
  }

  if (!queryIsReprint && titleIsReprint) {
    return "Reprint, commemorative, insert, or novelty card";
  }

  if (query.years.length && !query.years.some(year => title.text.includes(year))) {
    return "Missing the same card year";
  }

  if (query.cardNumbers.length && !query.cardNumbers.some(number => title.text.includes(`#${number}`) || title.tokenSet.has(number))) {
    return "Missing the same card number";
  }

  if (query.brands.length && query.brands.filter(term => title.tokenSet.has(term)).length === 0) {
    return "Missing the same card brand or set";
  }

  if (query.playerTokens.length >= 2) {
    const playerMatches = query.playerTokens.filter(token => title.tokenSet.has(token)).length;
    if (playerMatches < Math.min(2, query.playerTokens.length)) {
      return "Missing player-name match";
    }
  }

  if (query.graders.length) {
    const sameGrader = query.graders.some(grader => title.graders.includes(grader));
    if (!sameGrader) return "Missing the same grading company";
    if (query.grade && title.grade && query.grade !== title.grade) return "Different card grade";
  } else if (title.graders.length) {
    return "Graded slab comp for an ungraded or unspecified card";
  }

  const missingPremiumTrait = query.premiumTraits.find(term => !title.tokenSet.has(term));
  if (missingPremiumTrait) {
    return `Missing card trait: ${missingPremiumTrait}`;
  }

  if (!query.hasHighEndSignal && title.hasHighEndSignal) {
    return "Premium parallel, autograph, numbered, or graded comp not present in the search";
  }

  return "";
}

function comicCompQualityReason({ result, item }) {
  const queryText = String(item || "").toLowerCase();
  const title = String(result.title || "").toLowerCase();
  const queryIssues = [...new Set((queryText.match(/(?:#|issue\s*)\s*(\d{1,5})\b|\b(?:spider-man|spiderman|batman|x-men|superman|hulk|venom|spawn)\s+(\d{1,5})\b/g) || [])
    .map(match => (match.match(/\d{1,5}/) || [""])[0])
    .filter(Boolean))];
  const titleIssues = [...new Set((title.match(/(?:#|issue\s*)\s*(\d{1,5})\b|\b(?:spider-man|spiderman|batman|x-men|superman|hulk|venom|spawn)\s+(\d{1,5})\b/g) || [])
    .map(match => (match.match(/\d{1,5}/) || [""])[0])
    .filter(Boolean))];
  const queryIsVariant = /\b(variant|homage|facsimile|reprint|poster|sticker|magnet|print|clipping|page|true believers|iconic covers)\b/.test(queryText);
  const titleLooksNotComic = /\b(sticker|magnet|poster|print|clipping|magazine page|cover only|page only|shirt|t-shirt|keychain|card|trading card|patch|pin|button|dvd|blu-ray|figure|toy|upper deck|ud marvel|platinum iconic covers)\b/.test(title);
  const titleLooksVariant = /\b(variant|homage|facsimile|reprint|replica|foil cover|virgin cover|exclusive|true believers|iconic covers|family #1)\b/.test(title);
  const queryYears = [...new Set((queryText.match(/\b(?:19[6-9]\d|20[0-3]\d)\b/g) || []))];
  const titleYears = [...new Set((title.match(/\b(?:19[6-9]\d|20[0-3]\d)\b/g) || []))];

  if (/\b(u pick|you pick|choose|lot|bundle|set|collection)\b/.test(title)) {
    return "Comic lot or pick listing, not one exact issue";
  }

  if (titleLooksNotComic) {
    return "Comic-related accessory, not the comic book";
  }

  if (!queryIsVariant && titleLooksVariant) {
    return "Variant, homage, facsimile, or reprint not present in the search";
  }

  if (!queryYears.length && !queryIssues.length && titleYears.some(year => Number(year) >= 1991)) {
    return "Modern reissue, reprint, or later product for an original comic search";
  }

  if (queryIssues.length && titleIssues.length && !queryIssues.some(issue => titleIssues.includes(issue))) {
    return "Different comic issue number";
  }

  if (queryIssues.length && !queryIssues.some(issue => title.includes(`#${issue}`) || new RegExp(`\\b${issue}\\b`).test(title))) {
    return "Missing same comic issue number";
  }

  return "";
}

function hasEnoughSportsCardDetail(item) {
  const traits = extractCardTraits(item);
  const hasCardIdentifier = traits.years.length || traits.cardNumbers.length || traits.brands.length || traits.graders.length || traits.premiumTraits.length;
  return traits.playerTokens.length >= 1 && Boolean(hasCardIdentifier);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function inferCategoryFromItem(item) {
  const text = String(item || "").toLowerCase();
  const rules = [
    [/shoe|shoes|sneaker|sneakers|tennis shoe|running shoe|trainer|cleat|boot|boots|sandal|sandals|nike|adidas|new balance|asics|brooks|hoka|skechers|puma|reebok|converse|vans/, "Retail arbitrage"],
    [/apparel|clothing|shirt|pants|jacket|coat|dress|jeans|hoodie|sweater|sweatshirt|shorts|socks|hat|cap|\bsize\s*(?:xs|s|m|l|xl|xxl|\d{1,2}(?:\.\d)?(?:\s|$))|mens|women'?s|kids/, "Retail arbitrage"],
    [/painting|fine art|\bart\b|artist|canvas|oil painting|watercolor|lithograph|serigraph|signed print|framed art|sculpture|gallery label|provenance/, "Art and paintings"],
    [/lamp|lamps|lighting|chandelier|sconce|lantern|pendant light|table lamp|floor lamp|shade|finial|stiffel|laurel lamp|tiffany style|slag glass lamp/, "Lighting"],
    [/furniture|chair|chairs|table|side table|coffee table|dresser|chest|nightstand|cabinet|credenza|desk|bookshelf|bookcase|teak|walnut|mcm|mid century|eames|herman miller|knoll|heywood wakefield|lane acclaim/, "Furniture"],
    [/vase|vases|pottery|ceramic|porcelain|stoneware|raku|majolica|rookwood|roseville|weller|mccoy|fiesta|maker mark|bottom mark|glaze/, "Vases and pottery"],
    [/jewelry|jewellery|necklace|bracelet|earrings|brooch|pendant|sterling silver|diamond|gemstone|turquoise|karat|\b10k\b|\b14k\b|\b18k\b|\b925\b|tiffany|cartier|appraisal|gold ring|silver ring/, "Jewelry"],
    [/toy|toys|lego|american girl|hot wheels|matchbox|funko|pop figure|action figure|doll|barbie|transformers|star wars figure|playmobil|fisher price|fisher-price/, "Toys"],
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
  const listingCondition = String(result.condition || "").toLowerCase();
  const titleAndCondition = `${title} ${listingCondition}`;
  const itemText = String(item || "").toLowerCase();
  const total = Number(result.total || result.price || 0);
  const queryTokens = tokenizeText(item);
  const titleTokens = tokenizeText(title);
  const normalizedTitle = titleTokens.join(" ");
  const titleCompact = normalizedTitle.replace(/\s+/g, "");
  const queryCompact = queryTokens.join("");
  const stopWords = new Set(["the", "and", "with", "for", "vintage", "original", "rare", "old", "used"]);
  let strongCategoryMatch = false;
  const importantTokens = queryTokens
    .filter(token => token.length > 2 && !stopWords.has(token))
    .filter((token, index, array) => array.indexOf(token) === index);
  const matchedImportant = importantTokens.filter(token => titleTokens.includes(token) || titleCompact.includes(token));
  const partPatterns = {
    Instruments: /strings?|\bnut\b|saddles?|bridge pins?|guitar picks?|\bpicks?\b|truss rod tool|fingerboard|guitar case|hardshell case|wood case|strap button|guitar strap|strap lock|tuners?|tuning pegs?|control plate|pickguard|pickup|neck plate|\bneck\b|\bbody\b|bridge cover|knobs?|potentiometer|wiring harness|loaded guard|decals?/,
    Watches: /^for .*?(strap|bracelet|clasp|band)|strap only|watch strap|mesh strap|rubber\s+(?:band|strap)|watch\s+(?:band|strap)|watch bracelet|\b\d{1,2}mm\s+bracelet\b|bracelet link|watch clasp|\bclasp\b|pusher springs?|bezel insert|dial only|\bdial\s*(?:for|part|replacement)\b|hands only|hands set|\bwatch hands\b|movement only|\bwatch movement\b|\bnh3[5-6]a?\s+watch movement\b|case\s*&\s*movement|case and movement|watch case|case part|case only|case\s*back|caseback|warranty only|crystal|watch crown|crown only|crown stem|servicing|pressure test/,
    "Vintage audio": /rebuild set|recap kit|capacitor kit|resistors?|emitter resistor|transistors?|parting out|stripped|chassis only|front chassis|tuning board|phono board|p700 board|p400 board|potentiometer|switch assembly|output jack|rectifier|muting level|pre out|main in|jumper|tone\s*arm|tonearm|headshell|stylus|cartridge|knobs?\s*(?:only|set|part)|lamp\s*(?:only|kit|part)|led lamp|light bulbs?|fuse|owners? manual|service manual|manual only|remote only|remote control|feet|dial glass|dial window|window only|speaker foam|faceplate\s*(?:only|part)/,
    Pens: /nib only|nib unit|\bfeed\b|cap only|converter|refill|cartridge|empty box|clip only/,
    Books: /poster|dvd|blu-ray|audio cd|study guide|facsimile|reprint/,
    "Retail arbitrage": /lid only|brush|cleaner|scrub|replacement|mini|magnet/,
    Tools: /tool box|toolbox|tool chest|cabinet|drawer|organizer|battery|charger|case only|manual|parts|repair|adapter|extension|socket only|single socket|bit set|socket set|blade only|bare battery|battery pack|strap for|hanging strap|magnetic hanging strap|holster only|test leads? only|^(?:meter\s+)?leads?\b|test probe set|probes?\s+fit|leads?\s+(?:for|fit)/,
    Cameras: /body cap|strap|motor drive|battery grip|manual only|case only|lens cap|filter only|filter kit|lens accessory|accessory kit|adapter|remote control|wifi remote|battery only|charger only|dual charger|media mod|mount only|housing only/,
    Lighting: /bulb only|light bulb|replacement shade|shade only|lamp shade only|\b\d+\s+.*finials?\b|\blamp finials?\b|finials?\s*(?:only|set|lot|parts?)|lamp base|base only|socket only|cord only|harp only|lamp parts?|repair kit/,
    Furniture: /drawer pull|pulls only|knob only|hardware only|replacement leg|furniture pad|slipcover|cover only|cushion only|manual|plans only|cedar chest key|key only|lockset|\bmini\b.*cedar chest|cedar chest.*\bmini\b|miniature|minature|mini cedar|salesmans sample|salesman sample|keepsake|trinket box|jewelry box|dresser jewelry/,
    Toys: /instructions? manual|manual only|box only|boxes only|empty box|sticker sheet|replacement parts?|missing pieces|incomplete|partial set|minifig(?:ure)?s?\s*(?:only|from)|minifigure|accessor(?:y|ies)\s+only|light kit|display stand|manual\s*-|manual\s+for/
  };

  const partPattern = partPatterns[category];
  if (partPattern?.test(title)) return "Likely part or accessory, not the full item";
  if (category === "Cameras" && !/\bbody\b/.test(itemText) && /\b(body only|camera body)\b/.test(title)) {
    return "Camera body listing, not the requested complete camera or lens";
  }
  if (/\b(no pen|without pen|missing pen|no ear\s*pads?|without ear\s*pads?|missing ear\s*pads?|cradle only|charging cradle|partial(?:ly)? tested|partial test|powers on only|works\/read|read description|pieces come apart|comes apart)\b|\(\s*read\s*\)|headphones?\s*-\s*case\s*-/.test(titleAndCondition)) {
    return "Incomplete, partially tested, or disclosed-issue listing";
  }
  if (category === "Tools" && !/\bwrench\s+set\b|\bset\s+of\s+wrenches\b/.test(itemText) && /\bwrench\s+set\b/.test(title)) {
    return "Wrench set listing, not the requested single tool";
  }

  if (/\b(parts only|for parts|spares|spares\/repairs|repair|not working|needs service|sold as is|\bas is\b)\b/.test(titleAndCondition)) {
    return "Parts, repair, or as-is listing";
  }

  const itemDamageSpecified = /\b(chipped|chip|crack|cracked|damaged|broken|flawed|flaws|repair|as is|parts)\b/.test(String(item || "").toLowerCase());
  if (!itemDamageSpecified && /\b(chipped|big chip|chip\b|crack|cracked|damaged|broken|flawed|flaws)\b/.test(titleAndCondition)) {
    return "Damaged comp for a clean/unspecified item";
  }

  const queryLooksBulk = /\blot\b|\brolls?\b|\bset\b|\bcollection\b|\bbulk\b/.test(String(item || "").toLowerCase());
  const listingLooksBulk = /\blot\b|\brolls?\b|\bcollection\b|\bbulk\b|\byou pick\b|\bchoose your\b|\b\d+\s*(?:x\s*)?(?:coin|coins|card|cards|pc|pcs|piece|pieces)\b|\b(?:coin|card|piece)\s*lot\b|\blot\s*(?:of\s*)?\d+\b|\b\d+\s*lot\b/.test(title);
  if (!queryLooksBulk && listingLooksBulk) {
    return "Bundle, roll, set, or lot listing";
  }

  if (category === "Sports cards") {
    const cardReason = sportsCardCompQualityReason({ result, item });
    if (cardReason) return cardReason;
  }

  if (category === "Comic books") {
    const comicReason = comicCompQualityReason({ result, item });
    if (comicReason) return comicReason;
  }

  if (category === "Watches") {
    const itemText = String(item || "").toLowerCase();
    const requiredLines = ["seamaster", "speedmaster", "constellation", "submariner", "datejust", "daytona", "aqua terra", "planet ocean"];
    const missingLine = requiredLines.find(line => itemText.includes(line) && !title.includes(line));
    if (missingLine) return `Missing watch line: ${missingLine}`;
    if (/\brolex\b|\bsubmariner\b|\bdaytona\b|\bdatejust\b/.test(itemText)) {
      if (/\bbezel dot\b|insert pip|pip pearl|clear film|protection film|watch box|box for rolex|not the watch/.test(title)) {
        return "Premium watch accessory or box, not the full watch";
      }
      if (total > 0 && total < 1000) return "Premium watch price is too low, likely an accessory or box";
    }
  }

  if (category === "Vintage audio") {
    const itemText = String(item || "").toLowerCase();
    if (/\breceiver\b/.test(itemText) && !/\breceiver\b/.test(title)) {
      const modelTokens = tokenizeText(itemText).filter(token => /\d/.test(token) || ["marantz", "sansui", "pioneer"].includes(token));
      const matchedModelTokens = modelTokens.filter(token => titleTokens.includes(token));
      if (matchedModelTokens.length < Math.min(2, modelTokens.length)) return "Missing receiver match";
    }
    if (/\bturntable\b|sl[-\s]?1200|sl1200/.test(itemText) && !/\bturntable\b|sl[-\s]?1200|sl1200/.test(title)) return "Missing turntable model match";
    if (/sl[-\s]?1200|sl1200/.test(itemText) && total > 0 && total < 150) return "SL-1200 price is too low, likely an accessory or part";
  }

  if (category === "Jewelry") {
    const itemText = String(item || "").toLowerCase();
    if (/\b14k\b|\bgold\b/.test(itemText) && /\bgold over\b|gold plated|plated|stainless steel|moissanite/.test(title)) return "Plated, stainless, or simulant jewelry comp";
    if (/\bchain\b|\bnecklace\b/.test(itemText) && /\bclasp\b/.test(title)) return "Jewelry clasp or part, not full necklace";
  }

  if (category === "Lighting") {
    const itemText = String(item || "").toLowerCase();
    if (/\bbrass\b/.test(itemText) && /\btable lamp\b/.test(itemText) && /\bporcelain\b|\bceramic\b|\bfigurine\b/.test(title)) {
      return "Different lamp material or figurine style, not a brass table lamp";
    }
    if (!/\bfinials?\b/.test(itemText) && /\bfinials?\b/.test(title)) {
      return "Finial-focused lamp listing, not the requested complete lamp";
    }
  }

  if (category === "Vases and pottery") {
    const itemText = String(item || "").toLowerCase();
    const queryHasMaterial = /\b(porcelain|ceramic|pottery|stoneware|earthenware|glass|crystal|clay|raku|majolica)\b/.test(itemText);
    if (!queryHasMaterial && /\bporcelain\b/.test(title)) {
      return "Porcelain-specific comp for a vase without material proof";
    }
    const queryHasMaker = /\b(roseville|rookwood|weller|mccoy|fiesta|fiestaware|portmeirion|moorcroft|haeger|hull|van briggle|royal doulton|limoges)\b/.test(itemText);
    if (/\bsigned\b/.test(itemText) && !queryHasMaker && /\b(portmeirion|moorcroft|haeger|hull|van briggle|royal doulton|limoges)\b/.test(title)) {
      return "Maker-specific comp for a signed vase without readable maker proof";
    }
    if (/\broseville\b/.test(itemText) && /\br\.?\s*r\.?\s*p\.?\b|robinson[-\s]?ransbottom|crown mark|roseville ohio/.test(title)) {
      return "Different Roseville Ohio pottery maker, not Roseville Pottery";
    }
  }

  if (category === "Pens") {
    const itemText = String(item || "").toLowerCase();
    if (/\b51\b/.test(itemText) && !/\b51\b/.test(title)) return "Missing Parker 51 model match";
    if (/\bfountain\b/.test(itemText) && /\b(ballpoint|rollerball|pencil)\b/.test(title)) return "Different pen type";
  }

  if (category === "Tools") {
    const itemText = item.toLowerCase();
    if (/\bsnap[-\s]?on\b/.test(itemText) && !/\bsnap[-\s]?on\b/.test(title)) {
      return "Missing Snap-on brand match";
    }
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

  if (category === "Books") {
    const itemText = String(item || "").toLowerCase();
    if (/\bhobbit\b/.test(itemText) && !/\bhobbit\b/.test(title)) return "Missing Hobbit title match";
    if (/\bhobbit\b/.test(itemText) && /\b(art|letters|companion)\s+of\s+(?:the\s+)?hobbit|tolkien companion|lord of the rings|lotr|boxed set|box set|pocket edition|roverandom|iwanami|japanese\b/.test(title)) {
      return "Related Tolkien book, not the requested Hobbit edition";
    }
    if (!/\billustrated\b|\balan lee\b/.test(itemText) && /\billustrated\b|\balan lee\b/.test(title)) {
      return "Illustrated edition, not the requested rare-book edition";
    }
    if (/\bdust jacket\b|\bdj\b|\boriginal jacket\b/.test(itemText) && !/\bdust jacket\b|\bdj\b|\bw\/dust\b|\bdust cover\b|\boriginal jacket\b|with jacket/.test(title)) {
      return "Missing requested dust-jacket signal";
    }
    if (/\bfirst edition\b|\b1st\b|\bfirst printing\b|\b1st printing\b/.test(itemText)) {
      const hasEditionSignal = /\bfirst\b|\b1st\b|\bedition\b|\bprinting\b|\bimpression\b|\bprint\b/.test(title);
      if (!hasEditionSignal) return "Missing rare-book edition or printing signal";
    }
    if (/\bhobbit\b/.test(itemText) && /\b(first edition|1st|first printing|1st printing)\b/.test(itemText)) {
      const rareSignals = [
        /\bhobbit\b/.test(title),
        /\btolkien\b|j\.?\s*r\.?\s*r\.?/.test(title),
        /\bfirst\b|\b1st\b|\bedition\b|\bprinting\b|\bimpression\b|\bprint\b/.test(title),
        /\bdust jacket\b|\bdj\b|\bw\/dust\b|original jacket|with jacket/.test(title),
        /\bhardcover\b|\bhardback\b|\bhb\b|\bhard\s*back\b/.test(title)
      ].filter(Boolean).length;
      strongCategoryMatch = rareSignals >= 3 && /\bdust jacket\b|\bdj\b|\bw\/dust\b|original jacket|with jacket/.test(title);
    }
  }

  if (category === "Cameras") {
    const itemText = String(item || "").toLowerCase();
    if (/\blens\b/.test(itemText) && !/\blens\b/.test(title)) return "Missing lens match";
    if (/\bgopro\b/.test(itemText) && /\bhero\s*10\b/.test(itemText) && !/\bhero\s*10\b|\bhero10\b/.test(title)) return "Missing GoPro Hero 10 match";
  }

  if (category === "Toys") {
    const itemText = String(item || "").toLowerCase();
    const requiredSetNumbers = [...new Set((itemText.match(/\b\d{4,8}\b/g) || []))];
    const missingSetNumber = requiredSetNumbers.find(number => !title.includes(number));
    if (missingSetNumber) return `Missing toy set/model number: ${missingSetNumber}`;
    if (/\blego\b/.test(itemText) && /\bcompatible with lego\b|lego compatible|not lego|moc-/.test(title)) return "LEGO-compatible or MOC accessory, not official LEGO set";
  }

  if (category === "Furniture") {
    const itemText = String(item || "").toLowerCase();
    if (/\bcedar chest\b|\bhope chest\b/.test(itemText) && total > 0 && total < 75) return "Full-size chest price is too low, likely a mini, sample, key, or local artifact";
  }

  if (!strongCategoryMatch && importantTokens.length >= 3 && matchedImportant.length < Math.ceil(importantTokens.length * 0.6)) {
    return "Missing too many exact item terms";
  }

  const looseMatchThreshold = category === "Books"
    ? Math.max(2, Math.ceil(importantTokens.length * 0.6))
    : Math.max(2, importantTokens.length - 1);
  if (!strongCategoryMatch && queryCompact.length >= 8 && !titleCompact.includes(queryCompact) && matchedImportant.length < looseMatchThreshold) {
    return "Loose model match";
  }

  if (category === "Vintage audio" && total > 0 && total < 300 && /\b(knobs?|face\s*plate|faceplate|panel|switch|board|kit)\b/.test(title)) {
    return "Low-price audio part, not the full component";
  }

  if (ask >= 500 && total > 0 && total < ask * 0.35) {
    return "Price is too far below the source ask, likely a part or weak comp";
  }

  const confidenceFloor = category === "Vases and pottery" ? 52 : 58;
  if (Number(result.confidence || 0) < confidenceFloor) {
    return "Low title-match confidence";
  }

  return "";
}

function cleanForSaleQuery(item, category) {
  let query = normalizeWhitespace(item)
    .replace(/\bnot visible\b/gi, "")
    .replace(/\bunknown\b/gi, "")
    .replace(/\bera\b/gi, "")
    .replace(/\bcirca\b/gi, "")
    .replace(/\([^)]*\)/g, "")
    .trim();

  if (category === "Coins") {
    query = query
      .replace(/\bu\.?s\.?\b/gi, "")
      .replace(/\bmint mark\b/gi, "")
      .replace(/\bpenny\b/gi, "cent")
      .replace(/\b((?:17|18|19|20)\d{2})\s+([spdo])\b/gi, "$1-$2")
      .replace(/[^a-z0-9-]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (category === "Sports cards") {
    query = query
      .replace(/\bbaseball card\b/gi, "card")
      .replace(/\bsports card\b/gi, "card")
      .replace(/\s+/g, " ")
      .trim();
  }

  query = query
    .split(/\s+/)
    .filter((token, index, tokens) => token.toLowerCase() !== String(tokens[index - 1] || "").toLowerCase())
    .join(" ")
    .trim();

  return query || normalizeWhitespace(item);
}

function forSaleReferenceReason({ result, item, category }) {
  const title = String(result.title || "").toLowerCase();
  const queryText = String(item || "").toLowerCase();
  const queryLooksBulk = /\blot\b|\brolls?\b|\bset\b|\bcollection\b|\bbulk\b/.test(String(item || "").toLowerCase());
  const listingLooksBulk = /\blot\b|\brolls?\b|\bcollection\b|\bbulk\b|\b\d+\s*(?:x\s*)?(?:coin|coins|card|cards|pc|pcs|piece|pieces)\b|\b(?:coin|card|piece)\s*lot\b|\blot\s*(?:of\s*)?\d+\b|\b\d+\s*lot\b/.test(title);
  if (!queryLooksBulk && listingLooksBulk) return "Bundle, roll, set, or lot listing";
  if (/for parts|parts only|\bparts\b|broken|not working|repair|partial(?:ly)? tested|partial test|powers on only|works\/read|\(\s*read\s*\)|read description|pieces come apart|comes apart/.test(title)) return "Parts, repair, or disclosed-issue listing";
  if (/reproduction|replica|fake|counterfeit|copy|facsimile/.test(title)) return "Reproduction or authenticity risk";
  if (/nib unit|nib only|\bfeed\b|strap for|hanging strap|magnetic hanging strap|^(?:meter\s+)?leads?\b|test probe set|probes?\s+fit|leads?\s+(?:for|fit)|no pen|without pen|missing pen|no ear\s*pads?|without ear\s*pads?|missing ear\s*pads?|charging cradle|cradle only|headphones?\s*-\s*case\s*-/.test(title)) return "Part, accessory, or incomplete listing";

  const compReason = compQualityReason({ result, item, category });
  if (compReason) return compReason;

  if (category === "Coins") {
    if (/\.999|999 fine|copper round|bullion|commemorative|tribute|design|replica|copy|\brepo\b|novelty|coaster|not penny/.test(title) || (/\bround\b/.test(title) && /copper/.test(title))) {
      return "Replica, bullion round, or tribute item";
    }
    const titleHasVdb = /\bv\.?\s*d\.?\s*b\.?\b/.test(title);
    const queryHasVdb = /\bv\.?\s*d\.?\s*b\.?\b/.test(queryText);
    if (titleHasVdb && !queryHasVdb) {
      return "Different VDB variety not proven by the item photo";
    }
    const year = queryText.match(/\b(17|18|19|20)\d{2}\b/)?.[0] || "";
    const yearMint = queryText.match(/\b((?:17|18|19|20)\d{2})[-\s]+([spdo])\b/);
    if (year && new RegExp(`\\b${year}\\s*[–-]\\s*(?:17|18|19|20)\\d{2}\\b`).test(title)) {
      return "Date-range listing, not exact coin";
    }
    if (year && !new RegExp(`\\b${year}\\b`).test(title)) {
      return "Missing exact coin year";
    }
    if (yearMint) {
      const exactMint = new RegExp(`\\b${yearMint[1]}[-\\s]*${yearMint[2]}\\b`);
      const mintName = yearMint[2] === "s" ? /san francisco/ : yearMint[2] === "d" ? /denver/ : yearMint[2] === "o" ? /new orleans/ : /philadelphia/;
      if (!exactMint.test(title) && !mintName.test(title)) {
        return "Missing exact mint mark";
      }
    }
  }

  const qualityReason = compQualityReason({ result, item, category, ask: 0 });
  if (qualityReason && !["Low title-match confidence", "Loose model match"].includes(qualityReason)) {
    return qualityReason;
  }

  return "";
}

function forSaleListingCard(listing, index) {
  return {
    id: `for-sale-${index}`,
    kind: "listing",
    title: listing.title,
    price: Number(listing.price || 0),
    shipping: Number(listing.shipping || 0),
    total: Number(listing.price || 0) + Number(listing.shipping || 0),
    condition: listing.condition || "Unknown",
    source: listing.source || "eBay Browse API",
    url: listing.url,
    image: listing.image || "",
    confidence: Number(listing.confidence || 0),
    note: "Live asking-price result. Use it like Google Lens/Google shopping research, then verify exact identifiers and condition."
  };
}

function forSaleSearchCards(query) {
  const cards = [
    {
      title: `Search eBay active listings for ${query}`,
      source: "eBay search",
      url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`,
      note: "Open this search when fewer than three exact live listings pass the app's filters."
    },
    {
      title: `Search Google for ${query} for sale`,
      source: "Google web",
      url: `https://www.google.com/search?q=${encodeURIComponent(`${query} for sale`)}`,
      note: "This mirrors the quick field check: see how sellers describe and price similar items."
    },
    {
      title: `Search Google Shopping for ${query}`,
      source: "Google Shopping",
      url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`,
      note: "Use shopping results as asking-price research, not a final value."
    },
    {
      title: `Search WorthPoint archive for ${query}`,
      source: "WorthPoint",
      url: `https://www.worthpoint.com/inventory/search?query=${encodeURIComponent(query)}`,
      note: "Archive research can help when live listings are thin, but verify exact matches."
    }
  ];

  return cards.map((card, index) => ({
    id: `for-sale-search-${index}`,
    kind: "search",
    title: card.title,
    price: 0,
    shipping: 0,
    total: 0,
    condition: "Search",
    source: card.source,
    url: card.url,
    image: "",
    confidence: 0,
    note: card.note
  }));
}

async function findForSaleReferences(input, limit = 5) {
  const category = String(input.category || "").trim() || inferCategoryFromItem(input.item) || "Mixed sale";
  const rawItem = String(input.item || "").trim();
  if (!rawItem) return [];

  const query = cleanForSaleQuery(rawItem, category);
  if (!hasEbayCredentials()) return forSaleSearchCards(query).slice(0, limit);

  try {
    const result = await searchEbay({ item: query, category, limit: 50 });
    const primary = (result.results || [])
      .filter(listing => listing.url && Number(listing.price || 0) > 0)
      .filter(listing => !forSaleReferenceReason({ result: listing, item: query, category }))
      .slice(0, limit);

    const fallback = primary.length >= limit
      ? []
      : (result.results || [])
        .filter(listing => listing.url && Number(listing.price || 0) > 0)
        .filter(listing => !primary.some(item => item.url === listing.url))
        .filter(listing => !forSaleReferenceReason({ result: listing, item: query, category }))
        .filter(listing => Number(listing.confidence || 0) >= 58)
        .slice(0, limit - primary.length);

    const listings = [...primary, ...fallback].slice(0, limit).map(forSaleListingCard);
    const searchCards = forSaleSearchCards(query);

    return [...listings, ...searchCards].slice(0, limit);
  } catch (error) {
    console.warn(`For-sale reference search failed: ${error.message}`);
    return [];
  }
}

async function buildResearchFallbackDeal(input, reason) {
  const deal = buildFallbackDeal(input, reason);
  const forSaleResults = await findForSaleReferences({
    ...input,
    category: deal.category,
    item: deal.title
  });
  const askingPriceCount = forSaleResults.filter(result => result.kind !== "search" && Number(result.total || result.price || 0) > 0).length;

  return {
    ...deal,
    forSaleResults,
    marketEvidence: {
      status: askingPriceCount ? "asking-prices-only" : "research-links-only",
      label: askingPriceCount ? "No clean sold comps found" : "No clean sold or asking comps found",
      detail: askingPriceCount
        ? `The app could not accept a sold-comp set for this item, but found ${askingPriceCount} comparable active asking-price listing${askingPriceCount === 1 ? "" : "s"}. Treat these as seller expectations until a sold result confirms demand.`
        : "The app could not accept sold comps or close active listings. Use the searches below and add stronger identifiers before relying on a price.",
      askingPriceCount
    },
    checkedSources: [
      ...(deal.checkedSources || []),
      askingPriceCount ? "Comparable active asking prices" : forSaleResults.length ? "Open marketplace search links" : ""
    ].filter(Boolean)
  };
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
  const category = String(input.category || "").trim() || inferCategoryFromItem(item) || "Vintage audio";
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
  if (photoFiltered.length < 2) {
    throw new Error("Too few accepted marketplace results after comp-quality filtering");
  }
  const totals = photoFiltered.map(result => result.total);
  const low = percentile(totals, 0.15);
  const medianPrice = median(totals);
  const high = percentile(totals, 0.85);
  const fastSale = ask > 0 ? Math.max(ask + 20, low * 0.97) : low * 0.97;
  const floor = valuationFloor(category);
  if (floor && fastSale < floor) {
    throw new Error(`Accepted comps priced below ${category} sanity floor`);
  }
  const suggestedAsk = medianPrice;
  const avgConfidence = Math.round(average(photoFiltered.map(result => result.confidence)));
  const top = photoFiltered.slice(0, 6);
  const topImage = photoFiltered.find(result => result.image)?.image || null;
  const exactishMatches = photoFiltered.filter(result => result.confidence >= 75).length;
  const filteredCount = Math.max(0, Number(searchResult.total || rawPriced.length) - photoFiltered.length);
  const usesSoldComps = /sold|insights/i.test(String(searchResult.source || ""));
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
    valuationStatus: "valued",
    valuationMethod: usesSoldComps ? "sold-comps" : "active-market-comps",
    marketEvidence: usesSoldComps
      ? {
        status: "sold-comps",
        label: "Sold comps found",
        detail: `The app found ${photoFiltered.length} accepted sold/completed comp${photoFiltered.length === 1 ? "" : "s"} for this item.`,
        askingPriceCount: 0
      }
      : {
        status: "asking-prices-only",
        label: "No clean sold comps found",
        detail: `The app could not use a clean sold-comp set for this lookup, so this estimate is based on ${photoFiltered.length} comparable active asking-price listing${photoFiltered.length === 1 ? "" : "s"}. Treat it as seller expectation until sold comps confirm demand.`,
        askingPriceCount: photoFiltered.length
      },
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
    forSaleResults: [
      ...photoFiltered.slice(0, 3).map(forSaleListingCard),
      ...forSaleSearchCards(searchResult.query)
    ].slice(0, 5),
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
    checklist: category === "Sports cards"
      ? [
        "Match player, year, set, and card number",
        "Do not compare raw cards to PSA/SGC/BGS graded cards unless the grade matches",
        "Confirm rookie, parallel, autograph, serial number, and condition before trusting the price"
      ]
      : [
        "Match exact model, SKU, or reference",
        "Compare condition against the best-looking comp, not just the cheapest one",
        "Back out fees, shipping, repairs, and missing parts before paying"
      ],
    explanation,
    disclaimer: `Valuation uses accepted ${searchResult.source} comps and still needs your manual authenticity/condition check.`
  }, condition);
}

async function valueThroughSource(searchFn, input, category, source, limit = 36) {
  const attempts = [];
  let weakDeal = null;
  const minimumAccepted = minimumAcceptedCompsFor(category);
  for (const query of valuationSearchQueries(input.item, category)) {
    const attempt = {
      source,
      query,
      returned: 0,
      accepted: 0,
      error: ""
    };
    try {
      const searchResult = await searchFn({ item: query, category, limit });
      attempt.returned = Number(searchResult.results?.length || 0);

      if (!searchResult.results?.length) {
        attempts.push(attempt);
        continue;
      }

      const deal = await buildRealCompDeal(
        { ...input, item: String(input.item || query) },
        { ...searchResult, query, source }
      );
      attempt.accepted = Number(deal.comps || 0);
      attempts.push(attempt);
      if (Number(deal.comps || 0) < minimumAccepted) {
        weakDeal = weakDeal || deal;
        continue;
      }
      return { deal: { ...deal, valuationAttempts: attempts }, attempts };
    } catch (error) {
      attempt.error = error.message;
      attempts.push(attempt);
    }
  }

  return { deal: weakDeal ? { ...weakDeal, valuationAttempts: attempts } : null, attempts };
}

function shouldTryPriceCharting(category) {
  return ["Sports cards", "Comic books", "Coins"].includes(category);
}

function priceChartingConditionPrice(product, condition, item = "") {
  const prices = product.prices || {};
  const text = `${condition || ""} ${item || ""}`.toLowerCase();
  if (/\b(psa|sgc|bgs|beckett|cgc|graded|slab|9\.8|10)\b/.test(text)) {
    return prices.graded || prices.manualOnly || prices.loose || prices.cib || prices.new || 0;
  }
  if (/\b(sealed|new|unopened|mint)\b/.test(text)) return prices.new || prices.cib || prices.loose || prices.graded || 0;
  if (/\b(box|complete|cib)\b/.test(text)) return prices.cib || prices.loose || prices.new || 0;
  return prices.loose || prices.cib || prices.graded || prices.new || 0;
}

function priceChartingRange(product, selected) {
  const prices = Object.values(product.prices || {}).filter(value => Number(value || 0) > 0).sort((a, b) => a - b);
  if (!prices.length) return { low: selected, median: selected, high: selected };
  return {
    low: Math.min(selected || prices[0], prices[0]),
    median: selected || median(prices),
    high: Math.max(selected || prices[prices.length - 1], prices[prices.length - 1])
  };
}

function buildPriceChartingDeal(input, product) {
  const item = String(input.item || product.title || "Catalog item").trim();
  const category = String(input.category || "").trim() || inferCategoryFromItem(item) || "Mixed sale";
  const ground = String(input.ground || "Estate sale");
  const ask = Number(input.ask || 0);
  const condition = String(input.condition || "clean");
  const selected = priceChartingConditionPrice(product, condition, item);

  if (!selected) {
    throw new Error("PriceCharting match did not include a usable price for this condition");
  }

  const range = priceChartingRange(product, selected);
  const fastSale = Math.round(selected * 0.88);

  return applyConditionToDeal({
    title: item,
    category,
    ground,
    source: "PriceCharting API",
    valuationStatus: "valued",
    valuationMethod: "catalog-price-guide",
    ask,
    fastSale: ask > 0 ? Math.max(ask + 10, fastSale) : fastSale,
    allowBelowAsk: ask <= 0,
    suggestedAsk: Math.round(selected),
    priceLow: Math.round(range.low),
    priceMedian: Math.round(range.median),
    priceHigh: Math.round(range.high),
    comps: 1,
    compRange: `${money(range.low)}-${money(range.high)}`,
    absorption: "catalog",
    distance: Number(input.distance || 0),
    confidence: product.confidence,
    photo: fallbackPhoto(category, item),
    compLinks: [[`${product.categoryName || "Catalog"}: ${product.title}`, product.url]],
    compReview: {
      accepted: [{
        id: "accepted-pricecharting-0",
        title: `${product.title}${product.categoryName ? ` (${product.categoryName})` : ""}`,
        price: selected,
        shipping: 0,
        total: selected,
        condition: conditionDetails(condition).label,
        source: "PriceCharting API",
        url: product.url,
        image: "",
        confidence: product.confidence,
        included: true
      }],
      rejected: []
    },
    rareFact: rareFactFor(category, item),
    checklist: [
      "Match exact product, year, set, issue, variety, or catalog entry",
      "Use the condition or grade that matches the actual item",
      "Verify with sold comps when the item has autographs, variants, errors, restoration, or unusual provenance"
    ],
    explanation: `Valued from PriceCharting catalog data matched to “${product.title}”. Catalog values are structured current market guide prices, not a live sold-comp sample.`,
    disclaimer: "Catalog valuation needs exact product and condition verification before buying."
  }, condition);
}

async function valueThroughPriceCharting(input, category) {
  const attempts = [];

  if (!shouldTryPriceCharting(category)) {
    return { deal: null, attempts };
  }

  if (!hasPriceChartingCredentials()) {
    return { deal: null, attempts };
  }

  for (const query of valuationSearchQueries(input.item, category)) {
    const attempt = {
      source: "PriceCharting API",
      query,
      returned: 0,
      accepted: 0,
      error: ""
    };

    try {
      const product = await lookupPriceCharting({ item: query, category });
      attempt.returned = product?.id ? 1 : 0;
      const deal = buildPriceChartingDeal({ ...input, item: String(input.item || query) }, product);
      attempt.accepted = 1;
      attempts.push(attempt);
      return { deal: { ...deal, valuationAttempts: attempts }, attempts };
    } catch (error) {
      attempt.error = error.message;
      attempts.push(attempt);
    }
  }

  return { deal: null, attempts };
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
      valuationStatus: "no-value-signal",
      valuationMethod: "common-item-triage",
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
        [`Check sold results anyway: ${item}`, `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item)}&LH_Sold=1&LH_Complete=1`],
        [`Google web: ${item}`, `https://www.google.com/search?q=${encodeURIComponent(item)}`],
        [`Google Shopping: ${item}`, `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(item)}`]
      ],
      forSaleResults: forSaleSearchCards(item),
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
  const identifierReason = insufficientIdentifierReason(input.item, category);
  if (identifierReason) {
    return await buildResearchFallbackDeal(input, `${identifierReason} The app skipped broad marketplace valuation because vague watch comps can compare unrelated brands, parts, and condition tiers.`);
  }

  const accessoryReason = accessoryOnlyReason(input.item, category);
  if (accessoryReason) {
    return await buildResearchFallbackDeal(input, `${accessoryReason} The app skipped broad marketplace valuation so it does not compare an accessory, part, replica, or reprint against the main collectible.`);
  }

  const shouldTryReverb = ["Vintage audio", "Instruments"].includes(category);
  const shouldTrySoldComps = hasSoldCompsCredentials();
  const shouldTryEbaySoldComps = process.env.EBAY_ENABLE_MARKETPLACE_INSIGHTS === "true";
  const valuationAttempts = [];

  if (category === "Sports cards" && !hasEnoughSportsCardDetail(input.item)) {
    return await buildResearchFallbackDeal(input, "Sports-card pricing needs at least the player plus a year, set/brand, card number, rookie/parallel/autograph clue, or PSA/SGC/BGS grade. The app skipped broad comps because they can produce wrong prices.");
  }

  if (shouldTryPriceCharting(category)) {
    const catalogValue = await valueThroughPriceCharting(input, category);
    valuationAttempts.push(...catalogValue.attempts);
    if (catalogValue.deal) return catalogValue.deal;
  }

  if (shouldTrySoldComps) {
    const soldComps = await valueThroughSource(searchSoldComps, input, category, "SoldComps sold API", 48);
    valuationAttempts.push(...soldComps.attempts);
    if (soldComps.deal) return soldComps.deal;
  }

  if (shouldTryEbaySoldComps && hasEbayCredentials()) {
    const ebaySold = await valueThroughSource(searchEbaySold, input, category, "eBay Marketplace Insights API", 36);
    valuationAttempts.push(...ebaySold.attempts);
    if (ebaySold.deal) return ebaySold.deal;
  }

  if (shouldTryReverb && hasReverbCredentials()) {
    const reverb = await valueThroughSource(searchReverb, input, category, "Reverb API", 36);
    valuationAttempts.push(...reverb.attempts);
    if (reverb.deal) return reverb.deal;
  }

  if (hasEbayCredentials()) {
    const ebayActive = await valueThroughSource(searchEbay, input, category, "eBay Browse API", 50);
    valuationAttempts.push(...ebayActive.attempts);
    if (ebayActive.deal) return ebayActive.deal;
  }

  const checked = valuationAttempts.length
    ? `The valuation process tried ${valuationAttempts.length} comp search${valuationAttempts.length === 1 ? "" : "es"} but no accepted comp set survived filtering.`
    : "No valuation comp source is configured yet.";
  const deal = await buildResearchFallbackDeal(input, `${checked} The app is showing research mode instead of counting this as a valued item.`);
  return { ...deal, valuationAttempts };
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

async function readBetaTesters() {
  if (hasActivityDatabase()) {
    try {
      await ensureBetaTestersTable();
      const result = await activityPool().query("SELECT * FROM beta_testers ORDER BY last_seen_at DESC LIMIT 500");
      return result.rows.map(row => ({
        id: row.id,
        name: row.name || "",
        email: row.email || "",
        focus: row.focus || "",
        status: row.status || "accepted",
        agreementAccepted: Boolean(row.agreement_accepted),
        agreementVersion: row.agreement_version || "private-beta-v1",
        joinedAt: row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at || ""),
        lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at || ""),
        source: row.source || "",
        userAgent: row.user_agent || ""
      }));
    } catch (error) {
      console.warn(`Postgres beta tester read failed: ${error.message}`);
    }
  }

  try {
    const file = await fs.readFile(betaTestersPath, "utf8");
    return JSON.parse(file);
  } catch {
    return [];
  }
}

async function writeBetaTesters(testers) {
  if (hasActivityDatabase()) {
    try {
      await ensureBetaTestersTable();
      const pool = activityPool();
      for (const tester of testers) {
        await pool.query(`
          INSERT INTO beta_testers (
            id, name, email, focus, status, agreement_accepted, agreement_version,
            joined_at, last_seen_at, source, user_agent
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11
          )
          ON CONFLICT (email) DO UPDATE SET
            name = EXCLUDED.name,
            focus = EXCLUDED.focus,
            status = EXCLUDED.status,
            agreement_accepted = EXCLUDED.agreement_accepted,
            agreement_version = EXCLUDED.agreement_version,
            last_seen_at = EXCLUDED.last_seen_at,
            source = EXCLUDED.source,
            user_agent = EXCLUDED.user_agent;
        `, [
          tester.id,
          tester.name,
          tester.email,
          tester.focus,
          tester.status,
          Boolean(tester.agreementAccepted),
          tester.agreementVersion || "private-beta-v1",
          tester.joinedAt || new Date().toISOString(),
          tester.lastSeenAt || new Date().toISOString(),
          tester.source || "",
          tester.userAgent || ""
        ]);
      }
      return;
    } catch (error) {
      console.warn(`Postgres beta tester write failed: ${error.message}`);
    }
  }

  await fs.mkdir(path.dirname(betaTestersPath), { recursive: true });
  await fs.writeFile(betaTestersPath, `${JSON.stringify(testers, null, 2)}\n`);
}

async function readPhotoEvents() {
  try {
    const file = await fs.readFile(photoEventsPath, "utf8");
    return JSON.parse(file);
  } catch {
    return [];
  }
}

async function writePhotoEvent(event) {
  try {
    const events = await readPhotoEvents();
    await fs.writeFile(photoEventsPath, `${JSON.stringify([event, ...events].slice(0, 200), null, 2)}\n`);
  } catch (error) {
    console.warn(`Photo event log failed: ${error.message}`);
  }
}

function shortText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function betaScoutCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

function betaScoutInviteDefaults(invite = {}) {
  const code = betaScoutCode(invite.code);
  return {
    id: String(invite.id || code || Date.now()),
    code,
    name: shortText(invite.name, 80) || "Unnamed tester",
    email: shortText(invite.email, 120),
    notes: shortText(invite.notes, 500),
    active: invite.active !== false,
    createdAt: invite.createdAt || new Date().toISOString(),
    signedUpAt: invite.signedUpAt || "",
    agreementAcceptedAt: invite.agreementAcceptedAt || "",
    lastOpenedAt: invite.lastOpenedAt || ""
  };
}

async function readBetaScout() {
  try {
    const file = await fs.readFile(betaScoutPath, "utf8");
    const parsed = JSON.parse(file);
    return {
      testers: Array.isArray(parsed.testers) ? parsed.testers.map(betaScoutInviteDefaults).filter(tester => tester.code) : []
    };
  } catch {
    return { testers: [] };
  }
}

async function writeBetaScout(state) {
  await fs.mkdir(path.dirname(betaScoutPath), { recursive: true });
  await fs.writeFile(betaScoutPath, `${JSON.stringify({
    testers: (state.testers || []).map(betaScoutInviteDefaults).filter(tester => tester.code)
  }, null, 2)}\n`);
}

async function findBetaScoutInvite(code) {
  const normalizedCode = betaScoutCode(code);
  if (!normalizedCode) return null;
  const state = await readBetaScout();
  return state.testers.find(tester => tester.active && tester.code === normalizedCode) || null;
}

async function upsertBetaScoutTester(body) {
  const state = await readBetaScout();
  const code = betaScoutCode(body.code) || betaScoutCode(`GH-${Math.random().toString(36).slice(2, 8)}`);
  const existingIndex = state.testers.findIndex(tester => tester.code === code);
  const next = betaScoutInviteDefaults({
    ...(existingIndex >= 0 ? state.testers[existingIndex] : {}),
    ...body,
    code,
    active: body.active === undefined ? true : Boolean(body.active)
  });

  if (existingIndex >= 0) state.testers[existingIndex] = next;
  else state.testers.unshift(next);
  await writeBetaScout(state);
  return next;
}

async function markBetaScoutTester(code, patch) {
  const normalizedCode = betaScoutCode(code);
  if (!normalizedCode) return null;
  const state = await readBetaScout();
  const index = state.testers.findIndex(tester => tester.code === normalizedCode);
  if (index === -1) return null;
  state.testers[index] = betaScoutInviteDefaults({ ...state.testers[index], ...patch });
  await writeBetaScout(state);
  return state.testers[index];
}

function databaseUrl() {
  return String(process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
}

function hasActivityDatabase() {
  return Boolean(databaseUrl());
}

function activityPool() {
  if (!hasActivityDatabase()) return null;
  if (pgPool) return pgPool;

  try {
    const { Pool } = require("pg");
    const url = databaseUrl();
    const useSsl = /sslmode=require/i.test(url) || process.env.PGSSLMODE === "require";
    pgPool = new Pool({
      connectionString: url,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 3,
      idleTimeoutMillis: 10_000
    });
    return pgPool;
  } catch (error) {
    console.warn(`Postgres activity logging unavailable: ${error.message}`);
    return null;
  }
}

async function ensureActivityTable() {
  const pool = activityPool();
  if (!pool || activityTableReady) return Boolean(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      client_at TEXT,
      query TEXT,
      category TEXT,
      ground TEXT,
      condition TEXT,
      ask NUMERIC,
      distance NUMERIC,
      has_photo BOOLEAN,
      source TEXT,
      result_title TEXT,
      result_category TEXT,
      confidence NUMERIC,
      comps NUMERIC,
      valuation_status TEXT,
      valuation_method TEXT,
      feedback TEXT,
      tester_code TEXT,
      status TEXT,
      message TEXT,
      success BOOLEAN,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await pool.query("ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS valuation_status TEXT;");
  await pool.query("ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS valuation_method TEXT;");
  await pool.query("ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS tester_code TEXT;");
  await pool.query("CREATE INDEX IF NOT EXISTS activity_events_at_idx ON activity_events (at DESC);");
  activityTableReady = true;
  return true;
}

async function ensureBetaTestersTable() {
  const pool = activityPool();
  if (!pool || betaTestersTableReady) return Boolean(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS beta_testers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      focus TEXT,
      status TEXT NOT NULL DEFAULT 'accepted',
      agreement_accepted BOOLEAN NOT NULL DEFAULT false,
      agreement_version TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT,
      user_agent TEXT
    );
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS beta_testers_last_seen_idx ON beta_testers (last_seen_at DESC);");
  betaTestersTableReady = true;
  return true;
}

function normalizeDbActivityEvent(row) {
  return {
    id: row.id,
    type: row.type || "event",
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at || ""),
    clientAt: row.client_at || "",
    query: row.query || "",
    category: row.category || "",
    ground: row.ground || "",
    condition: row.condition || "",
    ask: Number(row.ask || 0),
    distance: Number(row.distance || 0),
    hasPhoto: Boolean(row.has_photo),
    source: row.source || "",
    resultTitle: row.result_title || "",
    resultCategory: row.result_category || "",
    confidence: Number(row.confidence || 0),
    comps: Number(row.comps || 0),
    valuationStatus: row.valuation_status || "",
    valuationMethod: row.valuation_method || "",
    feedback: row.feedback || "",
    testerCode: row.tester_code || row.payload?.testerCode || "",
    status: row.status || "",
    message: row.message || "",
    success: row.success
  };
}

async function readActivityEvents() {
  if (hasActivityDatabase()) {
    try {
      await ensureActivityTable();
      const result = await activityPool().query("SELECT * FROM activity_events ORDER BY at DESC LIMIT 500");
      return result.rows.map(normalizeDbActivityEvent);
    } catch (error) {
      console.warn(`Postgres activity read failed: ${error.message}`);
    }
  }

  try {
    const file = await fs.readFile(activityEventsPath, "utf8");
    return JSON.parse(file);
  } catch {
    return [];
  }
}

function sanitizeActivityEvent(body) {
  return {
    type: shortText(body.type, 48) || "event",
    at: new Date().toISOString(),
    clientAt: shortText(body.clientAt, 48),
    query: shortText(body.query),
    category: shortText(body.category, 80),
    ground: shortText(body.ground, 80),
    condition: shortText(body.condition, 80),
    ask: Number(body.ask || 0),
    distance: Number(body.distance || 0),
    hasPhoto: Boolean(body.hasPhoto),
    source: shortText(body.source, 120),
    resultTitle: shortText(body.resultTitle),
    resultCategory: shortText(body.resultCategory, 80),
    confidence: Number(body.confidence || 0),
    comps: Number(body.comps || 0),
    valuationStatus: shortText(body.valuationStatus, 80),
    valuationMethod: shortText(body.valuationMethod, 80),
    feedback: shortText(body.feedback, 80),
    testerCode: betaScoutCode(body.testerCode),
    status: shortText(body.status, 80),
    message: shortText(body.message),
    success: body.success === undefined ? null : Boolean(body.success)
  };
}

async function writeActivityEvent(body) {
  const event = sanitizeActivityEvent(body);

  if (hasActivityDatabase()) {
    try {
      await ensureActivityTable();
      const result = await activityPool().query(`
        INSERT INTO activity_events (
          type, at, client_at, query, category, ground, condition, ask, distance,
          has_photo, source, result_title, result_category, confidence, comps,
          valuation_status, valuation_method, feedback, tester_code, status, message, success, payload
        ) VALUES (
          $1, NOW(), $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22
        )
        RETURNING *;
      `, [
        event.type,
        event.clientAt,
        event.query,
        event.category,
        event.ground,
        event.condition,
        event.ask,
        event.distance,
        event.hasPhoto,
        event.source,
        event.resultTitle,
        event.resultCategory,
        event.confidence,
        event.comps,
        event.valuationStatus,
        event.valuationMethod,
        event.feedback,
        event.testerCode,
        event.status,
        event.message,
        event.success,
        JSON.stringify(event)
      ]);
      return normalizeDbActivityEvent(result.rows[0]);
    } catch (error) {
      console.warn(`Postgres activity write failed: ${error.message}`);
    }
  }

  try {
    const events = await readActivityEvents();
    await fs.writeFile(activityEventsPath, `${JSON.stringify([event, ...events].slice(0, 500), null, 2)}\n`);
    return event;
  } catch (error) {
    console.warn(`Activity event log failed: ${error.message}`);
    return null;
  }
}

function valuationBucket(event) {
  const status = String(event.valuationStatus || "").trim();
  if (status === "valued") return "valued";
  if (status === "no-value-signal") return "noValueSignal";
  if (status === "baseline") return "baseline";
  return "unknown";
}

async function valuationScoreboard() {
  const events = await readActivityEvents();
  const lookups = events
    .filter(event => event.type === "lookup-result")
    .slice(0, 100);
  const counts = {
    valued: 0,
    baseline: 0,
    noValueSignal: 0,
    unknown: 0
  };
  const categories = {};

  for (const event of lookups) {
    const bucket = valuationBucket(event);
    counts[bucket] += 1;
    const category = event.resultCategory || event.category || "Unknown";
    if (!categories[category]) {
      categories[category] = { total: 0, valued: 0, baseline: 0, noValueSignal: 0, unknown: 0 };
    }
    categories[category].total += 1;
    categories[category][bucket] += 1;
  }

  const total = lookups.length;
  const successCount = counts.valued + counts.noValueSignal;
  const coverage = total ? Math.round((successCount / total) * 100) : 0;
  const realValuedCoverage = total ? Math.round((counts.valued / total) * 100) : 0;

  return {
    window: Math.min(100, total),
    target: 90,
    coverage,
    realValuedCoverage,
    successCount,
    counts,
    ready: total >= 20 && coverage >= 90,
    needsSamples: Math.max(0, 20 - total),
    categories: Object.entries(categories)
      .map(([category, value]) => ({
        category,
        ...value,
        coverage: value.total ? Math.round(((value.valued + value.noValueSignal) / value.total) * 100) : 0
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12),
    recent: lookups.slice(0, 10).map(event => ({
      at: event.at,
      query: event.query,
      resultTitle: event.resultTitle,
      category: event.resultCategory || event.category,
      source: event.source,
      valuationStatus: event.valuationStatus || "unknown",
      valuationMethod: event.valuationMethod || "",
      comps: event.comps,
      confidence: event.confidence
    }))
  };
}

async function readReliabilityReport() {
  try {
    const file = await fs.readFile(reliabilityReportPath, "utf8");
    const report = JSON.parse(file);
    const suites = report.suites || {};
    const suiteList = Object.entries(suites).map(([key, suite]) => ({ key, ...suite }));
    const ready = suiteList.length >= 3 && suiteList.every(suite => suite.ready);
    return {
      updatedAt: report.updatedAt || "",
      ready,
      status: ready ? "Ready for more testers" : suiteList.length ? "Fix these first" : "No reliability run yet",
      suites,
      suiteList,
      weakSuites: suiteList.filter(suite => !suite.ready),
      trapsCaught: [
        "parts-only and accessory-only items",
        "replicas, reprints, proxy, and homage wording",
        "vague watches without brand/model proof",
        "wrong-category premium-name comps",
        "weak category evidence"
      ]
    };
  } catch {
    return {
      updatedAt: "",
      ready: false,
      status: "No reliability run yet",
      suites: {},
      suiteList: [],
      weakSuites: [],
      trapsCaught: []
    };
  }
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
    "SOLD_COMPS_API_KEY",
    "PRICECHARTING_TOKEN",
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

async function saveSoldCompsCredentials(body) {
  const values = await readEnvValues();
  const apiKey = String(body.apiKey || "").trim();

  if (apiKey) values.SOLD_COMPS_API_KEY = apiKey;
  if (!values.PORT) values.PORT = String(port);

  await fs.writeFile(envPath, serializeEnv(values), { mode: 0o600 });
  process.env.SOLD_COMPS_API_KEY = values.SOLD_COMPS_API_KEY || "";
  process.env.PORT = values.PORT;

  return configStatus(values);
}

async function savePriceChartingCredentials(body) {
  const values = await readEnvValues();
  const apiKey = String(body.apiKey || "").trim();

  if (apiKey) values.PRICECHARTING_TOKEN = apiKey;
  if (!values.PORT) values.PORT = String(port);

  await fs.writeFile(envPath, serializeEnv(values), { mode: 0o600 });
  process.env.PRICECHARTING_TOKEN = values.PRICECHARTING_TOKEN || "";
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
    soldComps: Boolean(values.SOLD_COMPS_API_KEY && !String(values.SOLD_COMPS_API_KEY).includes("your-")),
    priceCharting: Boolean(values.PRICECHARTING_TOKEN && !String(values.PRICECHARTING_TOKEN).includes("your-")),
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
    enabled: Boolean(betaAccessCode()),
    betaScout: true,
    agreementRequired: true
  };
}

function testerScoreFrom({ tester, events, finds }) {
  const testerEvents = events.filter(event => betaScoutCode(event.testerCode) === tester.code);
  const testerFinds = finds.filter(find => betaScoutCode(find.betaTesterCode) === tester.code);
  const opened = Boolean(tester.lastOpenedAt || testerEvents.some(event => event.type === "app-opened"));
  const tested = testerEvents.some(event => ["lookup-result", "lookup-feedback-marked", "photo-identify"].includes(event.type));
  const saved = testerFinds.length > 0 || testerEvents.some(event => ["save-find", "save-find-local"].includes(event.type));
  const feedback = testerFinds.some(find => find.betaFeedback || find.betaNotes) || testerEvents.some(event => ["feedback-marked", "lookup-feedback-marked", "status-updated"].includes(event.type) && (event.feedback || event.status));
  const signedUp = Boolean(tester.signedUpAt);
  const points = [signedUp, opened, tested, saved, feedback].filter(Boolean).length;

  return {
    signedUp,
    opened,
    tested,
    saved,
    feedback,
    points,
    savedCount: testerFinds.length,
    feedbackCount: testerFinds.filter(find => find.betaFeedback || find.betaNotes).length,
    eventCount: testerEvents.length
  };
}

async function betaScoutSummary() {
  const state = await readBetaScout();
  const events = await readActivityEvents();
  const finds = await readFinds();
  const testers = state.testers.map(tester => ({
    ...tester,
    score: testerScoreFrom({ tester, events, finds })
  }));
  const totals = testers.reduce((summary, tester) => {
    for (const key of ["signedUp", "opened", "tested", "saved", "feedback"]) {
      if (tester.score[key]) summary[key] += 1;
    }
    summary.points += tester.score.points;
    return summary;
  }, { invited: testers.length, signedUp: 0, opened: 0, tested: 0, saved: 0, feedback: 0, points: 0 });

  return {
    betaScout: true,
    generatedAt: new Date().toISOString(),
    totals,
    testers
  };
}

function publicTesterRecord(record) {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    focus: record.focus,
    status: record.status,
    joinedAt: record.joinedAt,
    lastSeenAt: record.lastSeenAt
  };
}

async function createBetaTester(body, request) {
  const submittedCode = betaScoutCode(body.code);
  const configuredCode = betaAccessCode();
  const invite = await findBetaScoutInvite(submittedCode);
  const codeAccepted = Boolean(invite) || !configuredCode || submittedCode === betaScoutCode(configuredCode);
  if (!codeAccepted) {
    return { status: 401, payload: { accepted: false, error: "That beta code did not work." } };
  }

  const name = shortText(body.name, 80);
  const email = shortText(body.email, 120).toLowerCase();
  const focus = shortText(body.focus, 160);
  const agreementAccepted = Boolean(body.agreementAccepted);
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 400, payload: { accepted: false, error: "Name and valid email are required." } };
  }
  if (!agreementAccepted) {
    return { status: 400, payload: { accepted: false, error: "Beta agreement must be accepted." } };
  }

  const testers = await readBetaTesters();
  const now = new Date().toISOString();
  const existingIndex = testers.findIndex(tester => String(tester.email || "").toLowerCase() === email);
  const base = existingIndex >= 0 ? testers[existingIndex] : {};
  const tester = {
    ...base,
    id: base.id || `tester-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    email,
    focus,
    status: base.status || "accepted",
    agreementAccepted: true,
    agreementVersion: "private-beta-v1",
    joinedAt: base.joinedAt || now,
    lastSeenAt: now,
    source: shortText(body.source, 80) || "beta gate",
    userAgent: shortText(request.headers["user-agent"], 240)
  };

  if (existingIndex >= 0) testers[existingIndex] = tester;
  else testers.unshift(tester);
  await writeBetaTesters(testers.slice(0, 500));
  if (invite) {
    await markBetaScoutTester(submittedCode, {
      name,
      email,
      signedUpAt: invite.signedUpAt || now,
      agreementAcceptedAt: invite.agreementAcceptedAt || now,
      lastOpenedAt: now
    });
  }
  await writeActivityEvent({
    type: existingIndex >= 0 ? "beta-tester-returned" : "beta-tester-signup",
    source: "beta gate",
    message: `${name} joined the private beta`,
    testerCode: invite ? submittedCode : "",
    status: tester.status,
    success: true
  });

  return {
    status: 201,
    payload: {
      accepted: true,
      enabled: Boolean(betaAccessCode()),
      tester: publicTesterRecord(tester)
    }
  };
}

async function healthStatus(request) {
  const values = await readEnvValues();
  const config = configStatus(values);
  const finds = await readFinds();
  const betaScout = await betaScoutSummary();
  const testers = await readBetaTesters();
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
    { label: "Sold comps", ok: config.soldComps || config.ebayMarketplaceInsights, detail: config.soldComps ? "SoldComps API key is configured." : config.ebayMarketplaceInsights ? "Marketplace Insights is enabled." : "Add a SoldComps key or wait for eBay Marketplace Insights approval." },
    { label: "Public URL", ok: Boolean(publicUrl) || !runningLocal, detail: publicUrl || (runningLocal ? "Running locally; deploy before outside beta." : `Running on ${requestHost}.`) },
    { label: "Beta Scout", ok: true, detail: `beta-scout=true; ${betaScout.totals.invited} tester invite${betaScout.totals.invited === 1 ? "" : "s"} tracked.` },
    { label: "Beta signups", ok: testers.length >= 1, detail: `${testers.length} beta tester${testers.length === 1 ? "" : "s"} signed up.` },
    { label: "Tester examples", ok: finds.length >= 5, detail: `${finds.length} saved find${finds.length === 1 ? "" : "s"} recorded.` },
  ];

  return {
    ok: checks.filter(check => check.ok).length >= 4,
    generatedAt: new Date().toISOString(),
    environment: {
      host: requestHost,
      local: runningLocal,
      publicUrl
    },
    betaScout: true,
    checks
  };
}

async function hasBetaAccess(request) {
  const code = betaAccessCode();
  const submittedCode = betaScoutCode(request.headers["x-beta-access-code"]);
  if (submittedCode && await findBetaScoutInvite(submittedCode)) return true;
  if (!code) return true;
  return submittedCode === betaScoutCode(code);
}

async function requireBetaAccess(request, response) {
  if (await hasBetaAccess(request)) return true;
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
  const allowed = ["Vintage audio", "Books", "Pens", "Watches", "Knives", "Instruments", "Retail arbitrage", "Tools", "Cameras", "Comic books", "Sports cards", "Sports memorabilia", "Coins", "Stamps", "Art and paintings", "Vases and pottery", "Jewelry", "Lighting", "Furniture", "Toys", "Mixed sale"];
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
  if (Array.isArray(value)) return value.map(item => normalizeVisionText(item, "")).filter(Boolean).join(" ").trim() || fallback;
  if (value && typeof value === "object") {
    const preferred = ["searchTerms", "title", "text", "value", "name", "player", "set", "brand", "cardNumber", "year"]
      .map(key => normalizeVisionText(value[key], ""))
      .filter(Boolean);
    if (preferred.length) return preferred.join(" ").replace(/\s+/g, " ").trim();
    return Object.values(value).map(item => normalizeVisionText(item, "")).filter(Boolean).join(" ").trim() || fallback;
  }
  return String(value || fallback).replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeVisionList(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeVisionText(item, "")).filter(Boolean).slice(0, 8);
  }
  const text = normalizeVisionText(value, "");
  return text ? [text] : [];
}

function compactVisionTerms(parts) {
  return normalizeWhitespace(parts.filter(Boolean).join(" "))
    .replace(/\bnot visible\b/gi, "")
    .replace(/\bunknown\b/gi, "")
    .replace(/\bpossibly\b|\bmaybe\b|\bappears to be\b/gi, "")
    .trim();
}

function buildVisionSearchTerms({ title, searchTerms, category, visibleClues, conditionClues, clue }) {
  const base = compactVisionTerms([searchTerms, title, clue]);
  const clueText = compactVisionTerms([...visibleClues, ...conditionClues]);
  const allText = `${base} ${clueText}`.toLowerCase();
  const terms = [base];

  const addMatches = (pattern, limit = 4) => {
    const matches = [...new Set((allText.match(pattern) || []).map(item => item.trim()))].slice(0, limit);
    if (matches.length) terms.push(matches.join(" "));
  };

  if (category === "Sports cards") {
    addMatches(/\b(?:18|19|20)\d{2}\b|\b(?:topps|bowman|panini|fleer|donruss|upper deck|prizm|select|optic|rookie|rc|psa|sgc|bgs)\b|#\s*[a-z0-9-]+/gi, 8);
  } else if (category === "Comic books") {
    addMatches(/\b(?:cgc|cbcS|newsstand|direct|variant|volume|vol\.?|#\s*\d+|\b\d{4}\b)\b/gi, 8);
  } else if (category === "Books") {
    addMatches(/\b(?:first|1st|edition|printing|impression|dust jacket|dj|signed|publisher|hardcover|hardback)\b/gi, 8);
  } else if (category === "Watches") {
    addMatches(/\b(?:omega|rolex|seiko|casio|cartier|seamaster|submariner|datejust|speedmaster|reference|ref\.?|automatic|quartz|chronograph)\b|ref\.?\s*[a-z0-9.-]+/gi, 8);
  } else if (category === "Vases and pottery") {
    addMatches(/\b(?:marked|signed|maker|stamp|japan|italy|germany|usa|pyrex|fiesta|fiestaware|roseville|weller|celadon|porcelain|stoneware)\b/gi, 8);
  } else if (category === "Retail arbitrage") {
    addMatches(/\b(?:upc|sku|model|style|size|sealed|new|nike|adidas|dyson|kitchenaid|all-clad)\b|(?:upc|sku|model|style)\s*[:#]?\s*[a-z0-9-]+/gi, 8);
  } else {
    addMatches(/\b(?:model|serial|ref|sku|upc|signed|marked|limited|sealed|vintage|maker)\b\s*[:#]?\s*[a-z0-9-]*/gi, 6);
  }

  return [...new Set(terms.map(normalizeWhitespace).filter(Boolean))].slice(0, 3).join(" ");
}

function photoNeedsUserClue({ title, category, confidence, visibleClues, clue }) {
  const text = `${title || ""} ${visibleClues.join(" ")}`.toLowerCase();
  if (clue) return false;
  if (!title || category === "Mixed sale" || confidence < 45) return true;
  if (/unknown item|unidentified|object|misc|decorative item|collectible item|vintage item/.test(text)) return true;
  return false;
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
  if (/apparel|clothing|shirt|pants|jacket|coat|dress|jeans|hoodie|sweater|sweatshirt|shorts|socks|hat|cap|\bsize\s*(?:xs|s|m|l|xl|xxl|\d{1,2}(?:\.\d)?(?:\s|$))|mens|women'?s|kids/.test(text)) {
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
    "category must be one of: Vintage audio, Books, Pens, Watches, Knives, Instruments, Retail arbitrage, Tools, Cameras, Comic books, Sports cards, Sports memorabilia, Coins, Stamps, Art and paintings, Vases and pottery, Jewelry, Lighting, Furniture, Toys, Mixed sale.",
    "Build searchTerms for valuation, not a caption. Include visible brand, maker, model, set number, serial/reference, year, material, size, title, edition, grade, card number, UPC/SKU, or bottom mark text when visible.",
    "If an identifier is not visible, do not guess it. Put the missing identifier in warning.",
    "For sports cards, include every visible identifier in searchTerms: player, year, set/brand, card number, rookie/RC, parallel/refractor/prizm color, autograph, serial number, and PSA/SGC/BGS grade if present.",
    "For sports cards, if the card number, set, year, or grade is not visible, say that in warning instead of guessing.",
    "For books, include title, author, edition/printing, publisher, dust jacket, signed/inscribed, and visible copyright-page clues.",
    "For pottery, vases, jewelry, watches, tools, cameras, and audio, include maker marks, model/reference numbers, labels, and condition clues visible in the photo.",
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
  const visibleClues = normalizeVisionList(parsed.visibleClues);
  const conditionClues = normalizeVisionList(parsed.conditionClues);
  const parsedCategory = normalizeVisionCategory(parsed.category);
  const retailCategory = retailCategoryFromText(`${title} ${searchTerms} ${clue}`);
  const category = parsedCategory === "Mixed sale" ? (retailCategory || parsedCategory) : parsedCategory;
  const confidence = normalizeVisionConfidence(parsed.confidence, title, category);
  const lookupTerms = category === "Sports cards"
    ? normalizeWhitespace(`${title} ${searchTerms}`).replace(/\bnot visible\b/gi, "").trim()
    : buildVisionSearchTerms({ title, searchTerms, category, visibleClues, conditionClues, clue });
  const lowValueSignal = normalizeVisionBoolean(parsed.lowValueSignal) || everydayItemSignal(`${title} ${searchTerms}`);
  const valueSignal = typeof parsed.valueSignal === "string" && !["true", "false"].includes(parsed.valueSignal.trim().toLowerCase())
    ? parsed.valueSignal
    : lowValueSignal
      ? "No obvious resale signal."
      : "Possible resale item; verify exact identity.";

  if (photoNeedsUserClue({ title, category, confidence, visibleClues, clue })) {
    return {
      configured: true,
      needsClue: true,
      message: "Photo ID needs one clue before valuation. Type the brand, maker mark, model, title, year, or what makes it special.",
      title,
      category,
      searchTerms: lookupTerms || title,
      visibleClues,
      conditionClues,
      confidence,
      warning: String(parsed.warning || "The photo did not show enough searchable identifiers.")
    };
  }

  return {
    configured: true,
    needsClue: false,
    title,
    category,
    searchTerms: lookupTerms || title,
    visibleClues: visibleClues.slice(0, 5),
    conditionClues: conditionClues.slice(0, 5),
    lowValueSignal,
    valueSignal,
    confidence,
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
  let filePath = path.normalize(path.join(root, requestedPath));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
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
      const submittedCode = betaScoutCode(body.code);
      const configuredCode = betaAccessCode();
      const invite = await findBetaScoutInvite(submittedCode);
      const accepted = Boolean(invite) || !configuredCode || submittedCode === betaScoutCode(configuredCode);
      const agreementAccepted = body.agreementAccepted === true;

      if (!agreementAccepted) {
        sendJson(response, 400, { accepted: false, enabled: Boolean(betaAccessCode()), error: "Beta agreement is required" });
        return;
      }

      if (accepted && invite) {
        await markBetaScoutTester(submittedCode, {
          signedUpAt: invite.signedUpAt || new Date().toISOString(),
          agreementAcceptedAt: invite.agreementAcceptedAt || new Date().toISOString()
        });
        await writeActivityEvent({
          type: "beta-signup",
          testerCode: submittedCode,
          status: "signed-up",
          success: true
        });
      }

      sendJson(response, accepted ? 200 : 401, {
        accepted,
        enabled: Boolean(betaAccessCode()),
        betaScout: Boolean(invite),
        tester: invite ? { code: invite.code, name: invite.name } : null
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/beta/signup") {
      const result = await createBetaTester(await readJsonBody(request), request);
      sendJson(response, result.status, result.payload);
      return;
    }

    if (url.pathname.startsWith("/api/") && !await requireBetaAccess(request, response)) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/beta-scout") {
      sendJson(response, 200, await betaScoutSummary());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/beta-scout/testers") {
      sendJson(response, 201, await upsertBetaScoutTester(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/photo/identify") {
      const body = await readJsonBody(request);
      const result = await identifyPhoto(body);
      await writePhotoEvent({
        type: "photo-identify",
        at: new Date().toISOString(),
        configured: Boolean(result.configured),
        needsClue: Boolean(result.needsClue),
        success: Boolean(result.configured && !result.needsClue),
        message: String(result.message || ""),
        title: String(result.title || ""),
        category: String(result.category || ""),
        searchTerms: String(result.searchTerms || ""),
        confidence: Number(result.confidence || 0),
        lowValueSignal: Boolean(result.lowValueSignal),
        clueProvided: Boolean(String(body.clue || "").trim()),
        imageBytesApprox: Math.round(String(body.imageData || "").length * 0.75)
      });
      await writeActivityEvent({
        type: "photo-identify",
        query: body.clue || "",
        hasPhoto: true,
        resultTitle: result.title || "",
        resultCategory: result.category || "",
        confidence: result.confidence || 0,
        message: result.message || "",
        success: Boolean(result.configured && !result.needsClue)
      });
      sendJson(response, 200, result);
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

    if (request.method === "GET" && url.pathname === "/api/activity") {
      sendJson(response, 200, await readActivityEvents());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/valuation/scoreboard") {
      sendJson(response, 200, await valuationScoreboard());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/reliability") {
      sendJson(response, 200, await readReliabilityReport());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/activity") {
      const body = await readJsonBody(request);
      const testerCode = betaScoutCode(body.testerCode || request.headers["x-beta-access-code"]);
      const event = await writeActivityEvent({ ...body, testerCode });
      if (testerCode && body.type === "app-opened") {
        await markBetaScoutTester(testerCode, { lastOpenedAt: new Date().toISOString() });
      }
      sendJson(response, 201, event);
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

    if (request.method === "POST" && url.pathname === "/api/config/soldcomps") {
      sendJson(response, 200, await saveSoldCompsCredentials(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/config/pricecharting") {
      sendJson(response, 200, await savePriceChartingCredentials(await readJsonBody(request)));
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
        evidenceType: String(body.evidenceType || ""),
        valuationStatus: String(body.valuationStatus || ""),
        valuationMethod: String(body.valuationMethod || ""),
        marketEvidence: body.marketEvidence && typeof body.marketEvidence === "object" ? body.marketEvidence : null,
        explanation: String(body.explanation || ""),
        compLinks: Array.isArray(body.compLinks) ? body.compLinks.slice(0, 6) : [],
        compReview: body.compReview && typeof body.compReview === "object" ? body.compReview : null,
        betaTesterCode: betaScoutCode(body.betaTesterCode || request.headers["x-beta-access-code"]),
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
        evidenceType: String(body.evidenceType || finds[index].evidenceType || ""),
        valuationStatus: String(body.valuationStatus || finds[index].valuationStatus || ""),
        valuationMethod: String(body.valuationMethod || finds[index].valuationMethod || ""),
        marketEvidence: body.marketEvidence && typeof body.marketEvidence === "object" ? body.marketEvidence : finds[index].marketEvidence || null,
        betaTesterCode: betaScoutCode(body.betaTesterCode || request.headers["x-beta-access-code"] || finds[index].betaTesterCode),
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

if (require.main === module) {
  server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    console.log(`The Great Hunt is live at http://${displayHost}:${port}`);
  });
}

module.exports = {
  buildLookupDeal,
  valuationScoreboard
};

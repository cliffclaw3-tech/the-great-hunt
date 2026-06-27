const { buildLookupDeal } = require("../server");
const { writeReliabilitySuite } = require("./reliability-report");

const cases = [
  { item: "Nike Air Max 90 men's sneakers", category: "Retail arbitrage" },
  { item: "All-Clad stainless saucepan", category: "Retail arbitrage" },
  { item: "KitchenAid stand mixer", category: "Retail arbitrage" },
  { item: "Dyson V8 cordless vacuum", category: "Retail arbitrage" },
  { item: "vintage Coleman lantern", category: "Lighting" },
  { item: "Stiffel brass table lamp pair", category: "Lighting" },
  { item: "Tiffany style stained glass lamp", category: "Lighting" },
  { item: "IKEA floor lamp", category: "Lighting" },
  { item: "MCM walnut coffee table", category: "Furniture" },
  { item: "Herman Miller Aeron chair", category: "Furniture" },
  { item: "Lane cedar chest", category: "Furniture" },
  { item: "IKEA Billy bookcase", category: "Furniture" },
  { item: "sterling silver turquoise ring", category: "Jewelry" },
  { item: "14k gold chain necklace", category: "Jewelry" },
  { item: "Tiffany silver heart bracelet", category: "Jewelry" },
  { item: "costume jewelry lot", category: "Jewelry" },
  { item: "LEGO Star Wars Millennium Falcon set 75192", category: "Toys" },
  { item: "American Girl doll Samantha", category: "Toys" },
  { item: "Hot Wheels Redline Camaro", category: "Toys" },
  { item: "Funko Pop Batman 01", category: "Toys" },
  { item: "Snap-on wrench set", category: "Tools" },
  { item: "DeWalt cordless drill", category: "Tools" },
  { item: "Starrett micrometer", category: "Tools" },
  { item: "Craftsman socket set", category: "Tools" },
  { item: "Canon AE-1 camera", category: "Cameras" },
  { item: "Nikon Nikkor 50mm f1.8 lens", category: "Cameras" },
  { item: "Polaroid SX-70 camera", category: "Cameras" },
  { item: "GoPro Hero 10", category: "Cameras" },
  { item: "Marantz 2230 receiver", category: "Vintage audio" },
  { item: "Technics SL-1200 turntable", category: "Vintage audio" },
  { item: "Bose Wave radio", category: "Vintage audio" },
  { item: "Sony Walkman cassette player", category: "Vintage audio" },
  { item: "Parker 51 fountain pen", category: "Pens" },
  { item: "Montblanc Meisterstuck pen", category: "Pens" },
  { item: "Waterman fountain pen", category: "Pens" },
  { item: "Cross ballpoint pen set", category: "Pens" },
  { item: "Omega Seamaster watch", category: "Watches" },
  { item: "Seiko SKX007 watch", category: "Watches" },
  { item: "Casio G-Shock watch", category: "Watches" },
  { item: "Rolex Submariner watch", category: "Watches" },
  { item: "Tolkien Hobbit hardcover dust jacket", category: "Books" },
  { item: "Harry Potter first edition hardcover", category: "Books" },
  { item: "signed Stephen King book", category: "Books" },
  { item: "vintage cookbook Joy of Cooking", category: "Books" },
  { item: "Pyrex Pink Daisy Cinderella bowl", category: "Vases and pottery" },
  { item: "Fiestaware pitcher", category: "Vases and pottery" },
  { item: "Roseville pottery vase", category: "Vases and pottery" },
  { item: "blue and white ceramic vase", category: "Vases and pottery" },
  { item: "Amazing Spider-Man 300 comic", category: "Comic books" },
  { item: "Batman Adventures 12 comic", category: "Comic books" },
  { item: "Spawn 1 comic", category: "Comic books" },
  { item: "X-Men 1 1991 comic", category: "Comic books" },
  { item: "1986 Fleer Michael Jordan rookie card #57", category: "Sports cards" },
  { item: "1965 Topps Mickey Mantle card #350", category: "Sports cards" },
  { item: "2020 Panini Prizm Justin Herbert rookie card", category: "Sports cards" },
  { item: "Pokemon Charizard Base Set card", category: "Sports cards" },
  { item: "Morgan silver dollar 1881 S", category: "Coins" },
  { item: "American Silver Eagle 1986", category: "Coins" },
  { item: "Wheat penny roll", category: "Coins" },
  { item: "1964 Kennedy half dollar", category: "Coins" }
];

const dirtyCompPattern = /\b(parts?|repair|spares|strap only|watch band|bracelet only|clasp|crown|caseback|case back|knob|finials?|lamp base|socket only|cord only|harp only|flawed|flaws|repair kit|recap kit|capacitor kit|filter kit|accessory kit|board|resistor|capacitor|manual only|box only|reprint|facsimile|novelty|pick your card|you pick|vending machine)\b/i;

const fastSaleFloors = {
  Watches: 40,
  Pens: 10,
  "Vintage audio": 25,
  "Retail arbitrage": 15,
  Cameras: 20,
  Tools: 15,
  Instruments: 50,
  Books: 8,
  "Sports cards": 5,
  "Comic books": 2,
  Coins: 5,
  "Vases and pottery": 8,
  Lighting: 10,
  Furniture: 20,
  Jewelry: 10,
  Toys: 8
};

function dirtyAcceptedComps(deal) {
  return (deal.compReview?.accepted || [])
    .filter(comp => dirtyCompPattern.test(`${comp.title || ""} ${comp.condition || ""}`))
    .slice(0, 3)
    .map(comp => comp.title);
}

function statusFor(deal, testCase) {
  const dirty = dirtyAcceptedComps(deal);
  const floor = Number(fastSaleFloors[testCase.category] || 0);
  const low = deal.valuationStatus === "valued" && Number(deal.fastSale || 0) < floor;
  const weak = deal.valuationStatus === "valued" && (Number(deal.comps || 0) < 2 || Number(deal.confidence || 0) < 45);
  const fieldChecks = deal.forSaleResults || [];
  const missingField = fieldChecks.length === 0;

  return {
    item: testCase.item,
    category: testCase.category,
    resultCategory: deal.category,
    status: deal.valuationStatus || "unknown",
    source: deal.source || "",
    comps: Number(deal.comps || 0),
    fastSale: Number(deal.fastSale || 0),
    confidence: Number(deal.confidence || 0),
    field: fieldChecks.length,
    dirty: dirty.length,
    dirtyExamples: dirty,
    low,
    weak,
    missingField,
    pass: ["valued", "no-value-signal"].includes(deal.valuationStatus) && dirty.length === 0 && !low && !weak && !missingField
  };
}

function summarize(rows) {
  return Object.entries(rows.reduce((groups, row) => {
    groups[row.category] = groups[row.category] || [];
    groups[row.category].push(row);
    return groups;
  }, {})).map(([category, categoryRows]) => {
    const passed = categoryRows.filter(row => row.pass).length;
    return {
      category,
      total: categoryRows.length,
      passed,
      coverage: Math.round((passed / categoryRows.length) * 100),
      failures: categoryRows.filter(row => !row.pass).map(row => ({
        item: row.item,
        status: row.status,
        source: row.source,
        comps: row.comps,
        fastSale: row.fastSale,
        confidence: row.confidence,
        dirtyExamples: row.dirtyExamples,
        low: row.low,
        weak: row.weak,
        missingField: row.missingField
      }))
    };
  }).sort((a, b) => a.coverage - b.coverage || a.category.localeCompare(b.category));
}

async function main() {
  const rows = [];
  for (const testCase of cases) {
    try {
      const deal = await buildLookupDeal({
        item: testCase.item,
        category: testCase.category,
        ground: "Estate sale",
        condition: "clean",
        ask: 0,
        distance: 3
      });
      rows.push(statusFor(deal, testCase));
    } catch (error) {
      rows.push({
        item: testCase.item,
        category: testCase.category,
        status: "error",
        source: error.message,
        comps: 0,
        fastSale: 0,
        confidence: 0,
        field: 0,
        dirty: 0,
        low: false,
        weak: true,
        missingField: true,
        pass: false
      });
    }
    await new Promise(resolve => setTimeout(resolve, 450));
  }

  const summary = summarize(rows);
  const passed = rows.filter(row => row.pass).length;
  writeReliabilitySuite("categories", {
    label: "Category sweep",
    command: "npm run audit:categories",
    total: rows.length,
    passed,
    failed: rows.length - passed,
    coverage: Math.round((passed / rows.length) * 100),
    ready: summary.every(row => row.coverage >= 90),
    risks: ["category-specific comp quality", "weak categories", "low price floors", "missing field checks"],
    weakCategories: summary.filter(row => row.coverage < 90),
    failures: summary.flatMap(row => row.failures.map(failure => ({ category: row.category, ...failure }))),
    byCategory: summary
  });
  console.table(rows.map(row => ({
    item: row.item,
    category: row.category,
    status: row.status,
    source: row.source,
    comps: row.comps,
    fastSale: row.fastSale,
    confidence: row.confidence,
    field: row.field,
    pass: row.pass ? "yes" : "",
    dirty: row.dirty || "",
    low: row.low ? "yes" : "",
    weak: row.weak ? "yes" : "",
    noField: row.missingField ? "yes" : ""
  })));
  console.log(JSON.stringify({
    total: rows.length,
    passed: rows.filter(row => row.pass).length,
    coverage: Math.round((rows.filter(row => row.pass).length / rows.length) * 100),
    weakCategories: summary.filter(row => row.coverage < 90),
    summary
  }, null, 2));

  if (summary.some(row => row.coverage < 90)) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

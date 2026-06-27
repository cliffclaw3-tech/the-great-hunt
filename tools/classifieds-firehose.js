const { buildLookupDeal } = require("../server");
const { writeReliabilitySuite } = require("./reliability-report");

const sourceTypes = ["Craigslist", "Marketplace", "Newspaper classifieds", "Community bulletin", "Yard sale flyer"];

const baseCases = [
  ["vintage Coleman lantern works garage cleanout", "Lighting", "opportunity", 20],
  ["Stiffel brass table lamp pair estate sale", "Lighting", "opportunity", 75],
  ["Tiffany style stained glass lamp moving sale", "Lighting", "opportunity", 40],
  ["lamp shade only for table lamp", "Lighting", "trap", 15],
  ["brass lamp finial lot", "Lighting", "trap", 10],
  ["IKEA floor lamp used dorm room", "Lighting", "research", 12],
  ["MCM walnut coffee table local pickup", "Furniture", "opportunity", 120],
  ["Herman Miller Aeron chair office cleanout", "Furniture", "opportunity", 180],
  ["Lane cedar chest needs refinishing", "Furniture", "opportunity", 80],
  ["IKEA Billy bookcase particle board", "Furniture", "research", 25],
  ["cedar chest key only", "Furniture", "trap", 8],
  ["mini cedar keepsake chest", "Furniture", "trap", 18],
  ["Snap-on wrench set estate garage", "Tools", "opportunity", 45],
  ["Snap-on ratchet case only", "Tools", "trap", 15],
  ["Fluke 87V multimeter tested", "Tools", "opportunity", 60],
  ["Fluke test leads for meter", "Tools", "trap", 18],
  ["Starrett micrometer machinist toolbox", "Tools", "opportunity", 25],
  ["DeWalt cordless drill no battery", "Tools", "research", 20],
  ["Canon AE-1 film camera estate sale", "Cameras", "opportunity", 45],
  ["Canon AE-1 body cap", "Cameras", "trap", 5],
  ["Nikon Nikkor 50mm f1.8 lens", "Cameras", "opportunity", 35],
  ["GoPro Hero 10 camera with accessories", "Cameras", "opportunity", 110],
  ["GoPro battery charger only", "Cameras", "trap", 12],
  ["Polaroid SX-70 camera untested", "Cameras", "research", 30],
  ["Marantz 2230 receiver works", "Vintage audio", "opportunity", 350],
  ["Marantz 2230 faceplate only", "Vintage audio", "trap", 90],
  ["Technics SL-1200 turntable tested", "Vintage audio", "opportunity", 375],
  ["Technics tonearm headshell", "Vintage audio", "trap", 40],
  ["Bose Wave radio estate sale", "Vintage audio", "opportunity", 35],
  ["Sony Walkman cassette player", "Vintage audio", "opportunity", 55],
  ["Omega Seamaster watch running", "Watches", "opportunity", 450],
  ["Omega Seamaster bracelet only", "Watches", "trap", 120],
  ["Rolex Submariner watch inherited", "Watches", "opportunity", 1000],
  ["Rolex Submariner homage watch", "Watches", "trap", 80],
  ["Seiko SKX007 watch", "Watches", "opportunity", 160],
  ["watch box for Rolex", "Watches", "trap", 55],
  ["Parker 51 fountain pen blue", "Pens", "opportunity", 30],
  ["Parker 51 pencil set", "Pens", "trap", 20],
  ["Montblanc Meisterstuck pen estate", "Pens", "opportunity", 80],
  ["fountain pen nib unit only", "Pens", "trap", 18],
  ["Waterman fountain pen old desk drawer", "Pens", "opportunity", 25],
  ["Cross ballpoint pen set", "Pens", "opportunity", 12],
  ["Tolkien Hobbit first edition hardcover dust jacket", "Books", "opportunity", 100],
  ["Tolkien Hobbit companion book", "Books", "opportunity", 15],
  ["signed Stephen King book", "Books", "opportunity", 20],
  ["Harry Potter first edition hardcover", "Books", "opportunity", 25],
  ["Joy of Cooking vintage cookbook", "Books", "opportunity", 5],
  ["facsimile reprint first edition book", "Books", "trap", 12],
  ["Pyrex Pink Daisy Cinderella mixing bowl", "Vases and pottery", "opportunity", 25],
  ["Roseville pottery vase", "Vases and pottery", "opportunity", 35],
  ["signed vase bottom mark unreadable", "Vases and pottery", "research", 20],
  ["signed ceramic vase bottom mark", "Vases and pottery", "opportunity", 20],
  ["blue and white ceramic vase", "Vases and pottery", "opportunity", 12],
  ["chipped Roseville pottery vase", "Vases and pottery", "research", 25],
  ["Tiffany silver heart bracelet", "Jewelry", "opportunity", 45],
  ["Tiffany style bracelet", "Jewelry", "trap", 15],
  ["14k gold chain necklace", "Jewelry", "opportunity", 60],
  ["gold plated chain necklace", "Jewelry", "research", 10],
  ["sterling silver turquoise ring", "Jewelry", "opportunity", 20],
  ["costume jewelry lot", "Jewelry", "opportunity", 10],
  ["LEGO Star Wars Millennium Falcon set 75192", "Toys", "opportunity", 300],
  ["LEGO Millennium Falcon box only", "Toys", "trap", 25],
  ["American Girl doll Samantha", "Toys", "opportunity", 35],
  ["Hot Wheels Redline Camaro", "Toys", "opportunity", 8],
  ["Funko Pop Batman 01", "Toys", "opportunity", 6],
  ["LEGO compatible light kit", "Toys", "trap", 18],
  ["Amazing Spider-Man 300 comic newsstand", "Comic books", "opportunity", 150],
  ["Amazing Spider-Man 300 reprint", "Comic books", "trap", 10],
  ["Batman Adventures 12 comic", "Comic books", "opportunity", 50],
  ["Spawn 1 comic", "Comic books", "opportunity", 5],
  ["X-Men 1 1991 comic", "Comic books", "opportunity", 2],
  ["1986 Fleer Michael Jordan rookie card #57", "Sports cards", "opportunity", 100],
  ["Michael Jordan rookie card reprint", "Sports cards", "trap", 8],
  ["1965 Topps Mickey Mantle card #350", "Sports cards", "opportunity", 80],
  ["Pokemon Charizard Base Set proxy card", "Sports cards", "trap", 12],
  ["2020 Panini Prizm Justin Herbert rookie card", "Sports cards", "opportunity", 20],
  ["Morgan silver dollar 1881 S", "Coins", "opportunity", 35],
  ["1881 S Morgan silver dollar PCGS MS63", "Coins", "opportunity", 70],
  ["American Silver Eagle 1986", "Coins", "opportunity", 35],
  ["Wheat penny roll", "Coins", "opportunity", 8],
  ["1964 Kennedy half dollar", "Coins", "opportunity", 10],
  ["Morgan silver dollar replica", "Coins", "trap", 5],
  ["Nike Air Max 90 men's sneakers", "Retail arbitrage", "opportunity", 25],
  ["Le Creuset skillet", "Retail arbitrage", "opportunity", 20],
  ["All-Clad stainless saucepan", "Retail arbitrage", "opportunity", 25],
  ["KitchenAid stand mixer", "Retail arbitrage", "opportunity", 75],
  ["Dyson V8 cordless vacuum no charger", "Retail arbitrage", "research", 60],
  ["Le Creuset lid only", "Retail arbitrage", "trap", 12],
  ["Gibson acoustic guitar", "Instruments", "opportunity", 500],
  ["Fender Stratocaster guitar", "Instruments", "opportunity", 350],
  ["guitar strap locks", "Instruments", "trap", 10],
  ["guitar case only", "Instruments", "trap", 40],
  ["synth keyboard estate sale", "Instruments", "opportunity", 125],
  ["Case pocket knife", "Knives", "opportunity", 20],
  ["Benchmade folding knife", "Knives", "opportunity", 60],
  ["knife sheath only", "Knives", "trap", 15]
];

function caseFor(row, index) {
  const [item, category, expect, ask] = row;
  const sourceType = sourceTypes[index % sourceTypes.length];
  const noise = sourceType === "Newspaper classifieds"
    ? "call after 5, cash only"
    : sourceType === "Marketplace"
      ? "porch pickup, cross posted"
      : sourceType === "Craigslist"
        ? "no holds, must pick up"
        : "Saturday sale";
  return {
    item: `${item} ${noise}`,
    cleanItem: item,
    category,
    expect,
    ask,
    sourceType
  };
}

function lookupItemFor(value) {
  return String(value || "")
    .replace(/\b(garage cleanout|estate sale|moving sale|local pickup|office cleanout|estate garage|Saturday sale)\b/gi, "")
    .replace(/\b(call after 5|cash only|porch pickup|cross posted|no holds|must pick up)\b/gi, "")
    .replace(/\b(needs refinishing|needs repair|untested|as is)\b/gi, "")
    .replace(/\bworks\b/gi, "working")
    .replace(/\s+/g, " ")
    .trim();
}

const dirtyCompPattern = /\b(parts?|repair|spares|strap only|watch band|rubber band|bracelet only|clasp|crown|caseback|case back|knob|finials?|lamp base|socket only|cord only|harp only|flawed|flaws|repair kit|recap kit|capacitor kit|filter kit|accessory kit|lamp kit|board|resistor|capacitor|manual only|box only|body cap|proxy|replica|homage|reprint|facsimile|novelty|pick your card|you pick|vending machine|lid only|case only|charger only|sheath only)\b/i;

function usefulNoValue(deal) {
  const hasProof = Array.isArray(deal.valuationProof?.missing) && deal.valuationProof.missing.length > 0;
  const hasSteps = Array.isArray(deal.nextResearchSteps) && deal.nextResearchSteps.length > 0;
  const hasFieldChecks = Array.isArray(deal.forSaleResults) && deal.forSaleResults.length > 0;
  return deal.valuationStatus === "no-value-signal" || (deal.valuationStatus === "baseline" && hasProof && hasSteps);
}

function dirtyAcceptedComps(deal, testCase) {
  const itemText = String(testCase.cleanItem || "").toLowerCase();
  const penAllowsBallpointSet = testCase.category === "Pens" && /\b(ballpoint|pen set|meisterstuck pen)\b/.test(itemText);
  return (deal.compReview?.accepted || [])
    .filter(comp => {
      const text = `${comp.title || ""} ${comp.condition || ""}`;
      if (penAllowsBallpointSet && /\b(ballpoint|pencil set|pen\s*&\s*pencil|2-piece set)\b/i.test(text)) return false;
      return dirtyCompPattern.test(text);
    })
    .slice(0, 4)
    .map(comp => comp.title);
}

function evaluate(testCase, deal) {
  const dirtyExamples = dirtyAcceptedComps(deal, testCase);
  const valued = deal.valuationStatus === "valued";
  const guidedResearch = usefulNoValue(deal);
  const fieldChecks = Array.isArray(deal.forSaleResults) ? deal.forSaleResults.length : 0;
  const weakEvidence = valued && (Number(deal.comps || 0) < 2 || Number(deal.confidence || 0) < 45);
  const suspiciousSpread = valued && Number(testCase.ask || 0) > 0 && Number(deal.fastSale || 0) < Number(testCase.ask || 0) * 0.35 && Number(deal.fastSale || 0) < 50;
  const expectationPass = testCase.expect === "trap"
    ? guidedResearch || !valued
    : testCase.expect === "research"
      ? guidedResearch || (valued && !dirtyExamples.length && !weakEvidence)
      : valued && !weakEvidence;
  const decisionPass = expectationPass && !dirtyExamples.length && !weakEvidence && !suspiciousSpread;
  const evidencePass = fieldChecks > 0;

  return {
    sourceType: testCase.sourceType,
    item: testCase.cleanItem,
    category: testCase.category,
    expect: testCase.expect,
    status: deal.valuationStatus || "unknown",
    source: deal.source || "",
    comps: Number(deal.comps || 0),
    fastSale: Number(deal.fastSale || 0),
    confidence: Number(deal.confidence || 0),
    fieldChecks,
    dirty: dirtyExamples.length,
    dirtyExamples,
    weakEvidence,
    suspiciousSpread,
    decisionPass,
    evidencePass,
    pass: decisionPass && evidencePass
  };
}

async function auditCase(testCase) {
  const lookupItem = lookupItemFor(testCase.cleanItem);
  const deal = await buildLookupDeal({
    item: lookupItem,
    category: testCase.category,
    ground: testCase.sourceType === "Newspaper classifieds" ? "Estate sale" : "Marketplace",
    condition: /only|reprint|proxy|replica|no charger|untested|chipped|needs/i.test(testCase.cleanItem) ? "rough" : "clean",
    ask: testCase.ask,
    distance: 8
  });
  return evaluate(testCase, deal);
}

function summarize(rows) {
  const groups = Object.entries(rows.reduce((all, row) => {
    all[row.category] = all[row.category] || [];
    all[row.category].push(row);
    return all;
  }, {})).map(([category, categoryRows]) => {
    const passed = categoryRows.filter(row => row.pass).length;
    const decisionPassed = categoryRows.filter(row => row.decisionPass).length;
    const evidencePassed = categoryRows.filter(row => row.evidencePass).length;
    return {
      category,
      total: categoryRows.length,
      passed,
      coverage: Math.round((passed / categoryRows.length) * 100),
      decisionCoverage: Math.round((decisionPassed / categoryRows.length) * 100),
      evidenceCoverage: Math.round((evidencePassed / categoryRows.length) * 100),
      failures: categoryRows.filter(row => !row.pass).map(row => ({
        item: row.item,
        sourceType: row.sourceType,
        expect: row.expect,
        status: row.status,
        source: row.source,
        comps: row.comps,
        fastSale: row.fastSale,
        confidence: row.confidence,
        dirtyExamples: row.dirtyExamples,
        weakEvidence: row.weakEvidence,
        suspiciousSpread: row.suspiciousSpread,
        fieldChecks: row.fieldChecks,
        decisionPass: row.decisionPass,
        evidencePass: row.evidencePass
      }))
    };
  }).sort((a, b) => a.coverage - b.coverage || a.category.localeCompare(b.category));
  return groups;
}

async function main() {
  const limit = Math.max(1, Number(process.env.CLASSIFIEDS_LIMIT || baseCases.length));
  const cases = baseCases.slice(0, limit).map(caseFor);
  const rows = [];

  for (const testCase of cases) {
    try {
      rows.push(await auditCase(testCase));
    } catch (error) {
      rows.push({
        sourceType: testCase.sourceType,
        item: testCase.cleanItem,
        category: testCase.category,
        expect: testCase.expect,
        status: "error",
        source: error.message,
        comps: 0,
        fastSale: 0,
        confidence: 0,
        fieldChecks: 0,
        dirty: 0,
        dirtyExamples: [],
        weakEvidence: true,
        suspiciousSpread: false,
        pass: false
      });
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  const summary = summarize(rows);
  const passed = rows.filter(row => row.pass).length;
  const decisionPassed = rows.filter(row => row.decisionPass).length;
  const evidencePassed = rows.filter(row => row.evidencePass).length;
  const coverage = Math.round((passed / rows.length) * 100);
  const decisionCoverage = Math.round((decisionPassed / rows.length) * 100);
  const evidenceCoverage = Math.round((evidencePassed / rows.length) * 100);
  const weakCategories = summary.filter(row => row.coverage < 90);
  const weakDecisionCategories = summary.filter(row => row.decisionCoverage < 90);
  const weakEvidenceCategories = summary.filter(row => row.evidenceCoverage < 90);

  writeReliabilitySuite("classifiedsFirehose", {
    label: "Classifieds firehose",
    command: "npm run audit:classifieds",
    total: rows.length,
    passed,
    failed: rows.length - passed,
    coverage,
    decisionCoverage,
    evidenceCoverage,
    ready: decisionCoverage >= 90 && weakDecisionCategories.length === 0,
    liveEvidenceReady: evidenceCoverage >= 90 && weakEvidenceCategories.length === 0,
    risks: ["messy classifieds wording", "parts-only listings", "local pickup noise", "newspaper-style vague ads", "Marketplace-style cross-post wording"],
    weakCategories,
    weakDecisionCategories,
    weakEvidenceCategories,
    failures: summary.flatMap(row => row.failures.map(failure => ({ category: row.category, ...failure }))),
    byCategory: summary
  });

  console.table(rows.map(row => ({
    item: row.item,
    source: row.sourceType,
    category: row.category,
    expect: row.expect,
    status: row.status,
    comps: row.comps,
    fastSale: row.fastSale,
    confidence: row.confidence,
    field: row.fieldChecks,
    pass: row.pass ? "yes" : "",
    decision: row.decisionPass ? "yes" : "",
    evidence: row.evidencePass ? "yes" : "",
    dirty: row.dirty || "",
    weak: row.weakEvidence ? "yes" : "",
    spread: row.suspiciousSpread ? "yes" : ""
  })));
  console.log(JSON.stringify({
    total: rows.length,
    passed,
    coverage,
    decisionCoverage,
    evidenceCoverage,
    weakCategories,
    weakDecisionCategories,
    weakEvidenceCategories,
    failures: summary.flatMap(row => row.failures.map(failure => ({ category: row.category, ...failure })))
  }, null, 2));

  if (decisionCoverage < 90 || weakDecisionCategories.length) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

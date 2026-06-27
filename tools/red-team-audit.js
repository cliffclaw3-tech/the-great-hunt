const { buildLookupDeal } = require("../server");
const { writeReliabilitySuite } = require("./reliability-report");

const cases = [
  { persona: "vague", item: "old lamp", category: "Lighting", expect: "cautious" },
  { persona: "vague", item: "signed vase", category: "Vases and pottery", expect: "cautious" },
  { persona: "vague", item: "baseball card", category: "Sports cards", expect: "research" },
  { persona: "vague", item: "watch", category: "Watches", expect: "cautious" },
  { persona: "fake-premium", item: "Rolex Submariner watch", category: "Watches", expect: "valued" },
  { persona: "fake-premium", item: "Rolex Submariner watch band", category: "Watches", expect: "not-valued" },
  { persona: "fake-premium", item: "Tiffany silver heart bracelet", category: "Jewelry", expect: "valued" },
  { persona: "fake-premium", item: "Tiffany style stained glass lamp", category: "Lighting", expect: "valued" },
  { persona: "parts-trap", item: "Marantz 2230 faceplate", category: "Vintage audio", expect: "not-valued" },
  { persona: "parts-trap", item: "Omega Seamaster bracelet only", category: "Watches", expect: "not-valued" },
  { persona: "parts-trap", item: "LEGO Millennium Falcon box only", category: "Toys", expect: "not-valued" },
  { persona: "parts-trap", item: "Canon AE-1 camera body cap", category: "Cameras", expect: "not-valued" },
  { persona: "replica", item: "Pokemon Charizard Base Set proxy card", category: "Sports cards", expect: "not-valued" },
  { persona: "replica", item: "Rolex Submariner homage watch", category: "Watches", expect: "not-valued" },
  { persona: "replica", item: "Tiffany style lamp", category: "Lighting", expect: "valued" },
  { persona: "common", item: "IKEA Billy bookcase", category: "Furniture", expect: "not-valued" },
  { persona: "common", item: "Target floor lamp", category: "Lighting", expect: "cautious" },
  { persona: "condition", item: "cracked Roseville pottery vase", category: "Vases and pottery", expect: "cautious" },
  { persona: "condition", item: "damaged Lane cedar chest", category: "Furniture", expect: "cautious" },
  { persona: "precision", item: "1986 Fleer Michael Jordan rookie card #57 PSA 8", category: "Sports cards", expect: "valued" },
  { persona: "precision", item: "1881 S Morgan silver dollar PCGS MS63", category: "Coins", expect: "valued" },
  { persona: "precision", item: "Tolkien Hobbit first edition hardcover dust jacket", category: "Books", expect: "valued" },
  { persona: "wrong-category", item: "Snap-on ratchet case only", category: "Tools", expect: "not-valued" },
  { persona: "wrong-category", item: "Parker 51 pencil set", category: "Pens", expect: "not-valued" }
];

const dirtyCompPattern = /\b(parts?|repair|spares|strap only|watch band|rubber band|bracelet only|clasp|crown|caseback|case back|knob|finials?|lamp base|socket only|cord only|harp only|flawed|flaws|repair kit|recap kit|capacitor kit|filter kit|accessory kit|lamp kit|board|resistor|capacitor|manual only|box only|body cap|proxy|replica|homage|pencil set|ballpoint|reprint|commemorative|porcelain|facsimile|novelty|pick your card|you pick|vending machine)\b/i;

const floorByCategory = {
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
    .slice(0, 4)
    .map(comp => comp.title);
}

function isUsefulNoValue(deal) {
  const hasProof = Array.isArray(deal.valuationProof?.missing) && deal.valuationProof.missing.length > 0;
  const hasSteps = Array.isArray(deal.nextResearchSteps) && deal.nextResearchSteps.length > 0;
  const hasFieldChecks = Array.isArray(deal.forSaleResults) && deal.forSaleResults.length > 0;
  return deal.valuationStatus === "no-value-signal" || (deal.valuationStatus === "baseline" && hasProof && hasSteps && hasFieldChecks);
}

function fieldCheckStatus(deal) {
  const results = deal.forSaleResults || [];
  return {
    fieldChecks: results.length,
    missingFieldCheck: results.length === 0
  };
}

function evaluateExpectation(testCase, deal) {
  const dirty = dirtyAcceptedComps(deal);
  const floor = Number(floorByCategory[testCase.category] || 0);
  const suspiciousLow = deal.valuationStatus === "valued" && Number(deal.fastSale || 0) < floor;
  const weakEvidence = deal.valuationStatus === "valued" && (Number(deal.comps || 0) < 2 || Number(deal.confidence || 0) < 45);
  const valuedCleanly = deal.valuationStatus === "valued" && !dirty.length && !suspiciousLow && !weakEvidence;
  const usefulNoValue = isUsefulNoValue(deal);
  const cautious = valuedCleanly || usefulNoValue;

  const expectationPass = testCase.expect === "valued"
    ? valuedCleanly
    : testCase.expect === "not-valued"
      ? usefulNoValue
      : testCase.expect === "research"
        ? usefulNoValue
        : cautious;

  return {
    expectationPass,
    dirty,
    suspiciousLow,
    weakEvidence,
    valuedCleanly,
    usefulNoValue,
    ...fieldCheckStatus(deal)
  };
}

async function auditCase(testCase) {
  const started = Date.now();
  const deal = await buildLookupDeal({
    item: testCase.item,
    persona: testCase.persona,
    category: testCase.category,
    ground: "Estate sale",
    condition: /cracked|damaged|parts|only|proxy|homage/i.test(testCase.item) ? "rough" : "clean",
    ask: 0,
    distance: 3
  });
  const result = evaluateExpectation(testCase, deal);

  return {
    item: testCase.item,
    persona: testCase.persona,
    category: testCase.category,
    expect: testCase.expect,
    status: deal.valuationStatus || "unknown",
    method: deal.valuationMethod || "",
    source: deal.source || "",
    comps: Number(deal.comps || 0),
    fastSale: Number(deal.fastSale || 0),
    confidence: Number(deal.confidence || 0),
    ms: Date.now() - started,
    pass: result.expectationPass && !result.missingFieldCheck,
    ...result
  };
}

function summarize(rows) {
  const total = rows.length;
  const passed = rows.filter(row => row.pass).length;
  const failed = rows.filter(row => !row.pass);
  const byPersona = Object.entries(rows.reduce((groups, row) => {
    groups[row.persona] = groups[row.persona] || [];
    groups[row.persona].push(row);
    return groups;
  }, {})).map(([persona, personaRows]) => ({
    persona,
    total: personaRows.length,
    passed: personaRows.filter(row => row.pass).length,
    coverage: Math.round((personaRows.filter(row => row.pass).length / personaRows.length) * 100)
  })).sort((a, b) => a.coverage - b.coverage || a.persona.localeCompare(b.persona));

  return {
    total,
    passed,
    failed: failed.length,
    coverage: Math.round((passed / total) * 100),
    byPersona,
    failures: failed.map(row => ({
      item: row.item,
      persona: row.persona,
      expect: row.expect,
      status: row.status,
      source: row.source,
      comps: row.comps,
      fastSale: row.fastSale,
      confidence: row.confidence,
      dirtyExamples: row.dirty,
      suspiciousLow: row.suspiciousLow,
      weakEvidence: row.weakEvidence,
      missingFieldCheck: row.missingFieldCheck
    }))
  };
}

async function main() {
  const rows = [];
  for (const testCase of cases) {
    try {
      rows.push(await auditCase(testCase));
    } catch (error) {
      rows.push({
        item: testCase.item,
        persona: testCase.persona,
        category: testCase.category,
        expect: testCase.expect,
        status: "error",
        source: error.message,
        comps: 0,
        fastSale: 0,
        confidence: 0,
        pass: false,
        dirty: []
      });
    }
    await new Promise(resolve => setTimeout(resolve, 550));
  }

  const summary = summarize(rows);
  writeReliabilitySuite("redTeam", {
    label: "Red-team sweep",
    command: "npm run audit:redteam",
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    coverage: summary.coverage,
    ready: summary.coverage >= 90 && summary.failed === 0,
    risks: ["vague items", "parts-only traps", "replicas", "wrong-category comps", "precision collector cases"],
    failures: summary.failures,
    byPersona: summary.byPersona
  });
  console.table(rows.map(row => ({
    item: row.item,
    persona: row.persona,
    expect: row.expect,
    status: row.status,
    source: row.source || "",
    comps: row.comps || 0,
    fastSale: row.fastSale || 0,
    confidence: row.confidence || 0,
    pass: row.pass ? "yes" : "",
    dirty: row.dirty?.length || "",
    low: row.suspiciousLow ? "yes" : "",
    weak: row.weakEvidence ? "yes" : "",
    noField: row.missingFieldCheck ? "yes" : ""
  })));
  console.log(JSON.stringify(summary, null, 2));

  if (summary.coverage < 90 || summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

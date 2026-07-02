const { buildLookupDeal } = require("../server");
const { writeReliabilitySuite } = require("./reliability-report");

const cases = [
  { persona: "garage-sale", item: "Le Creuset skillet", category: "Retail arbitrage" },
  { persona: "garage-sale", item: "Nikon film camera lens", category: "Cameras" },
  { persona: "garage-sale", item: "Snap-on ratchet", category: "Tools" },
  { persona: "garage-sale", item: "Parker 51 fountain pen", category: "Pens" },
  { persona: "garage-sale", item: "Tolkien Hobbit hardcover dust jacket", category: "Books" },
  { persona: "garage-sale", item: "Pyrex nesting mixing bowl", category: "Vases and pottery" },
  { persona: "garage-sale", item: "vintage brass table lamp", category: "Lighting" },
  { persona: "garage-sale", item: "MCM teak side table", category: "Furniture" },
  { persona: "collector", item: "Amazing Spider-Man 300 comic newsstand", category: "Comic books" },
  { persona: "collector", item: "1986 Fleer Michael Jordan rookie card #57", category: "Sports cards" },
  { persona: "collector", item: "1881 S Morgan silver dollar PCGS MS63", category: "Coins" },
  { persona: "collector", item: "Parker 51 vacumatic fountain pen blue diamond", category: "Pens" },
  { persona: "collector", item: "Pyrex Pink Daisy Cinderella mixing bowl", category: "Vases and pottery" },
  { persona: "collector", item: "Tolkien Hobbit first edition hardcover dust jacket", category: "Books" },
  { persona: "investor", item: "Omega Seamaster watch", category: "Watches" },
  { persona: "investor", item: "Marantz 2230 receiver", category: "Vintage audio" },
  { persona: "investor", item: "Gibson acoustic guitar", category: "Instruments" },
  { persona: "investor", item: "1965 Topps Mickey Mantle card #350", category: "Sports cards" },
  { persona: "investor", item: "Amazing Spider-Man 300 comic", category: "Comic books" },
  { persona: "investor", item: "Morgan silver dollar 1881 S", category: "Coins" },
  { persona: "investor", item: "signed ceramic vase bottom mark", category: "Vases and pottery" },
  { persona: "investor", item: "Rolex Submariner watch", category: "Watches" },
  { persona: "collector", item: "Super Mario 64 Nintendo 64 complete in box", category: "Video games" },
  { persona: "collector", item: "Super Mario 64", category: "Video games" },
  { persona: "collector", item: "Super Mario 64 DS Nintendo DS", category: "Video games" },
  { persona: "collector", item: "Super Mario 64 Nintendo 64 complete in box", category: "Video games", ask: 999 },
  { persona: "garage-sale", item: "one-off handmade unlabeled shelf doodad", category: "Mixed sale", ask: 500 },
  { persona: "collector", item: "Mario Kart Nintendo 64 complete in box", category: "Video games" }
];

const dirtyCompPattern = /\b(for parts|parts only|repair|spares|strap|watch band|rubber band|bracelet only|clasp|crown|caseback|case back|knob|finials?|lamp base|socket only|cord only|harp only|flawed|flaws|repair kit|recap kit|capacitor kit|filter kit|accessory kit|lamp kit|board|resistor|capacitor|manual only|box only|pencil set|ballpoint|reprint|commemorative|porcelain|facsimile|novelty|pick your card|you pick|vending machine)\b/i;
const fastSaleFloors = {
  Watches: 100,
  Pens: 20,
  "Vintage audio": 250,
  "Retail arbitrage": 15,
  Cameras: 25,
  Tools: 20,
  Instruments: 150,
  Books: 10,
  "Sports cards": 5,
  "Comic books": 5,
  Coins: 10,
  "Vases and pottery": 10,
  Lighting: 15,
  Furniture: 25
};

const CASE_TIMEOUT_MS = Number(process.env.VALUATION_AUDIT_CASE_TIMEOUT_MS || 45000);

const minimumCompCounts = {
  "Sports cards": 3,
  "Comic books": 3,
  Watches: 3,
  Coins: 3,
  "Vintage audio": 3,
  Instruments: 3
};

function dirtyAcceptedComps(deal) {
  return (deal.compReview?.accepted || [])
    .filter(comp => dirtyCompPattern.test(`${comp.title || ""} ${comp.condition || ""}`))
    .slice(0, 4)
    .map(comp => comp.title);
}

function fieldCheckStatus(deal) {
  const results = deal.forSaleResults || [];
  const hasListing = results.some(result => result.kind === "listing" && result.url);
  const hasEbaySearch = results.some(result => /ebay/i.test(`${result.source || ""} ${result.title || ""}`) && result.url);
  const hasGoogleSearch = results.some(result => /google/i.test(`${result.source || ""} ${result.title || ""}`) && result.url);

  return {
    fieldChecks: results.length,
    missingFieldCheck: !(hasListing || (hasEbaySearch && hasGoogleSearch))
  };
}

function researchGuidanceStatus(deal) {
  const hasProofList = Array.isArray(deal.valuationProof?.missing) && deal.valuationProof.missing.length > 0;
  const hasNextSteps = Array.isArray(deal.nextResearchSteps) && deal.nextResearchSteps.length > 0;
  const missingResearchGuidance = deal.valuationStatus === "baseline" && !(hasProofList && hasNextSteps);

  return {
    missingResearchGuidance
  };
}

async function auditCase(testCase) {
  const started = Date.now();
  const deal = await buildLookupDeal({
    item: testCase.item,
    persona: testCase.persona || "general",
    category: testCase.category,
    ground: "Estate sale",
    condition: "clean",
    ask: Number(testCase.ask || 0),
    distance: 3
  });
  const elapsedMs = Date.now() - started;
  const dirty = dirtyAcceptedComps(deal);
  const fieldCheck = fieldCheckStatus(deal);
  const researchGuidance = researchGuidanceStatus(deal);
  const minimumComps = Number(minimumCompCounts[testCase.category] || 2);
  const weakEvidence = deal.valuationStatus === "valued"
    && (Number(deal.comps || 0) < minimumComps || Number(deal.confidence || 0) < 45);

  return {
    item: testCase.item,
    persona: testCase.persona || "general",
    category: testCase.category,
    status: deal.valuationStatus || "unknown",
    method: deal.valuationMethod || "",
    source: deal.source || "",
    comps: Number(deal.comps || 0),
    fastSale: Number(deal.fastSale || 0),
    confidence: Number(deal.confidence || 0),
    acceptedTitles: (deal.compReview?.accepted || []).map(comp => comp.title || ""),
    elapsedMs,
    dirtyAccepted: dirty.length,
    dirtyExamples: dirty,
    ...fieldCheck,
    ...researchGuidance,
    suspiciousLow: deal.valuationStatus === "valued" && Number(deal.fastSale || 0) < Number(fastSaleFloors[testCase.category] || 0),
    weakEvidence
  };
}

function timeoutCase(testCase) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({
        item: testCase.item,
        persona: testCase.persona || "general",
        category: testCase.category,
        status: "unknown",
        method: "audit-timeout",
        source: "",
        comps: 0,
        fastSale: 0,
        confidence: 0,
        acceptedTitles: [],
        elapsedMs: CASE_TIMEOUT_MS,
        dirtyAccepted: 0,
        dirtyExamples: [],
        fieldChecks: 0,
        missingFieldCheck: true,
        missingResearchGuidance: false,
        suspiciousLow: false,
        weakEvidence: false,
        error: `Timed out after ${Math.round(CASE_TIMEOUT_MS / 1000)}s`
      });
    }, CASE_TIMEOUT_MS);
  });
}

function auditCaseWithTimeout(testCase) {
  return Promise.race([
    auditCase(testCase),
    timeoutCase(testCase)
  ]);
}

function acceptanceFlags(row) {
  const item = String(row.item || "").toLowerCase();
  const status = String(row.status || "").toLowerCase();
  const source = String(row.source || "").toLowerCase();
  const method = String(row.method || "").toLowerCase();
  const isResearch = status === "baseline" || method.includes("weak-evidence") || method.includes("baseline");
  const acceptedTitles = (row.acceptedTitles || []).join(" ").toLowerCase();

  if (item === "super mario 64") {
    return isResearch ? [] : ["Bare Super Mario 64 should route to Research/disambiguate"];
  }

  if (item.includes("nintendo 64") && item.includes("super mario 64")) {
    const hasDsEvidence = /\bds\b|nintendo ds/.test(acceptedTitles);
    return hasDsEvidence ? ["N64 Mario accepted DS evidence"] : [];
  }

  if (item.includes("nintendo ds")) {
    const ok = source || method || status;
    return ok ? [] : ["DS control did not return a meaningful status"];
  }

  return [];
}

function coverage(rows) {
  const total = rows.length;
  const valued = rows.filter(row => row.status === "valued").length;
  const noValue = rows.filter(row => row.status === "no-value-signal").length;
  const baseline = rows.filter(row => row.status === "baseline").length;
  const unknown = rows.filter(row => row.status === "unknown" || row.error).length;
  const dirty = rows.filter(row => row.dirtyAccepted > 0).length;
  const suspiciousLow = rows.filter(row => row.suspiciousLow).length;
  const weakEvidence = rows.filter(row => row.weakEvidence).length;
  const slow = rows.filter(row => Number(row.elapsedMs || 0) > 9000).length;
  const missingFieldCheck = rows.filter(row => row.missingFieldCheck).length;
  const missingResearchGuidance = rows.filter(row => row.missingResearchGuidance).length;
  const acceptanceFailures = rows.reduce((sum, row) => sum + acceptanceFlags(row).length, 0);

  return {
    total,
    valued,
    noValue,
    baseline,
    unknown,
    dirty,
    suspiciousLow,
    weakEvidence,
    slow,
    missingFieldCheck,
    missingResearchGuidance,
    acceptanceFailures,
    coverage: total ? Math.round(((valued + noValue) / total) * 100) : 0,
    cleanCoverage: total ? Math.round(((valued + noValue - dirty - suspiciousLow - weakEvidence - missingFieldCheck - missingResearchGuidance) / total) * 100) : 0
  };
}

function personaCoverage(rows) {
  return Object.entries(rows.reduce((groups, row) => {
    const persona = row.persona || "general";
    groups[persona] = groups[persona] || [];
    groups[persona].push(row);
    return groups;
  }, {})).map(([persona, personaRows]) => ({
    persona,
    ...coverage(personaRows)
  }));
}

async function main() {
  const rows = [];
  for (const testCase of cases) {
    try {
      rows.push(await auditCaseWithTimeout(testCase));
    } catch (error) {
      rows.push({
        item: testCase.item,
        persona: testCase.persona || "general",
        category: testCase.category,
        status: "error",
        method: "audit-error",
        error: error.message,
        comps: 0,
        fastSale: 0,
        confidence: 0,
        acceptedTitles: [],
        dirtyAccepted: 0,
        dirtyExamples: [],
        fieldChecks: 0,
        missingFieldCheck: true,
        missingResearchGuidance: false,
        suspiciousLow: false,
        weakEvidence: false
      });
    }
    await new Promise(resolve => setTimeout(resolve, 650));
  }

  const summary = coverage(rows);
  writeReliabilitySuite("valuation", {
    label: "Valuation audit",
    command: "npm run audit:valuation",
    total: summary.total,
    passed: summary.valued + summary.noValue,
    failed: summary.total - summary.valued - summary.noValue,
    coverage: summary.coverage,
    cleanCoverage: summary.cleanCoverage,
    ready: summary.coverage >= 90 && summary.cleanCoverage >= 90 && summary.dirty === 0 && summary.suspiciousLow === 0 && summary.weakEvidence === 0 && summary.missingFieldCheck === 0 && summary.missingResearchGuidance === 0 && summary.acceptanceFailures === 0,
    risks: ["garage-sale lookups", "collector precision", "investor categories", "dirty comps", "weak evidence"],
    failures: [
      ...rows.filter(row => row.dirtyAccepted).map(row => ({ item: row.item, reason: "Dirty accepted comp", examples: row.dirtyExamples })),
      ...rows.filter(row => row.suspiciousLow).map(row => ({ item: row.item, reason: "Suspiciously low valuation", fastSale: row.fastSale })),
      ...rows.filter(row => row.weakEvidence).map(row => ({ item: row.item, reason: "Weak evidence", comps: row.comps, confidence: row.confidence })),
      ...rows.filter(row => row.missingFieldCheck).map(row => ({ item: row.item, reason: "Missing field-check links" })),
      ...rows.filter(row => row.missingResearchGuidance).map(row => ({ item: row.item, reason: "Missing research guidance" })),
      ...rows.flatMap(row => acceptanceFlags(row).map(reason => ({ item: row.item, reason })))
    ],
    personas: personaCoverage(rows)
  });
  console.table(rows.map(row => ({
    item: row.item,
    persona: row.persona,
    category: row.category,
    status: row.status,
    source: row.source || row.error || "",
    comps: row.comps || 0,
    fastSale: row.fastSale || 0,
    confidence: row.confidence || 0,
    field: row.fieldChecks || 0,
    ms: row.elapsedMs || 0,
    dirty: row.dirtyAccepted || 0,
    low: row.suspiciousLow ? "yes" : "",
    weak: row.weakEvidence ? "yes" : "",
    noField: row.missingFieldCheck ? "yes" : "",
    noGuide: row.missingResearchGuidance ? "yes" : "",
    accept: acceptanceFlags(row).join("; ")
  })));
  console.log(JSON.stringify({
    summary,
    personas: personaCoverage(rows),
    dirtyExamples: rows.filter(row => row.dirtyAccepted).map(row => ({ item: row.item, examples: row.dirtyExamples })),
    suspiciousLow: rows.filter(row => row.suspiciousLow).map(row => ({ item: row.item, fastSale: row.fastSale, floor: fastSaleFloors[row.category] })),
    weakEvidence: rows.filter(row => row.weakEvidence).map(row => ({ item: row.item, comps: row.comps, confidence: row.confidence })),
    missingFieldCheck: rows.filter(row => row.missingFieldCheck).map(row => ({ item: row.item, fieldChecks: row.fieldChecks })),
    missingResearchGuidance: rows.filter(row => row.missingResearchGuidance).map(row => ({ item: row.item })),
    acceptanceFailures: rows.flatMap(row => acceptanceFlags(row).map(reason => ({ item: row.item, reason })))
  }, null, 2));

  if (summary.coverage < 90 || summary.cleanCoverage < 90 || summary.dirty > 0 || summary.suspiciousLow > 0 || summary.weakEvidence > 0 || summary.missingFieldCheck > 0 || summary.missingResearchGuidance > 0 || summary.acceptanceFailures > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  process.exit(process.exitCode || 0);
});

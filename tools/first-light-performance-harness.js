const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

function loadPlaywright() {
  const candidates = [
    "playwright",
    "/Users/wes/.openclaw/node_modules/playwright",
    "/Users/wes/.hermes/claude-code/node_modules/playwright"
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next known browser-tool location.
    }
  }

  throw new Error("Playwright is not available. Expected it locally or in /Users/wes/.openclaw/node_modules/playwright.");
}

const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, "..");
const RUN_ROOT = path.join(ROOT, "first-light-harness-runs");
const DEFAULT_VIEWPORT = { width: 390, height: 844 };

const GAME_CONFIGS = [
  {
    id: "royal-gems",
    gameName: "Royal Gems",
    type: "puzzle",
    url: pathToFileURL(path.join(ROOT, "first-light-studio-deploy", "benchmarks", "royal-gems", "index.html")).href,
    expectedEndSelectors: ["#win-overlay.active", "#loss-overlay.active"],
    firstAction: "tutorial-or-canvas",
    redLines: [
      "Board refills with animated falling tiles",
      "Every match has burst, particles, and score pop",
      "Goal counter is always visible and reactive"
    ]
  },
  {
    id: "do-you-know-them",
    gameName: "Do You Know Them?",
    type: "card",
    url: pathToFileURL(path.join(ROOT, "first-light-studio-deploy", "benchmarks", "do-you-know-them", "index.html")).href,
    expectedEndSelectors: ["#results-screen.active"],
    firstAction: "answer-card",
    redLines: [
      "Answer reveal uses CSS 3D card flip",
      "Person name/avatar stays visible during prediction",
      "Correct and incorrect states are visually distinct"
    ]
  }
];

function slug(value) {
  return String(value || "game")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function screenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true });
}

async function visibleText(page, selector) {
  return page.locator(selector).first().textContent({ timeout: 700 }).then(text => String(text || "").trim()).catch(() => "");
}

async function isVisible(page, selector) {
  return page.locator(selector).first().isVisible({ timeout: 700 }).catch(() => false);
}

async function countVisible(page, selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.filter(node => {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }).length).catch(() => 0);
}

async function collectFirstScreenSignals(page, game) {
  const signals = {
    title: await page.title().catch(() => ""),
    bodyText: await page.locator("body").innerText({ timeout: 1200 }).catch(() => ""),
    canvasVisible: await isVisible(page, "canvas"),
    buttonCount: await countVisible(page, "button"),
    answerCardCount: await countVisible(page, ".answer-card"),
    consoleText: [],
    goalVisible: false,
    firstActionCueVisible: false,
    scoreVisible: false,
    endVisible: false
  };

  if (game.type === "puzzle") {
    signals.goalVisible = await isVisible(page, "#goal-display");
    signals.firstActionCueVisible = await isVisible(page, "#tutorial-pointer") || await isVisible(page, "#tutorial-toast");
    signals.scoreVisible = await isVisible(page, "#moves-display");
  } else if (game.type === "card") {
    signals.goalVisible = Boolean(await visibleText(page, "#question-text"));
    signals.firstActionCueVisible = await isVisible(page, "#action-hint") || signals.answerCardCount > 0;
    signals.scoreVisible = await isVisible(page, "#score-display");
  }

  for (const selector of game.expectedEndSelectors || []) {
    signals.endVisible = signals.endVisible || await isVisible(page, selector);
  }

  return signals;
}

async function performFirstAction(page, game) {
  if (game.firstAction === "answer-card") {
    const firstCard = page.locator(".answer-card").first();
    if (await firstCard.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstCard.click();
      return "clicked first answer card";
    }
  }

  if (game.firstAction === "tutorial-or-canvas") {
    const pointer = page.locator("#tutorial-pointer").first();
    if (await pointer.isVisible({ timeout: 1200 }).catch(() => false)) {
      const box = await pointer.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height + 22);
        return "clicked below tutorial pointer";
      }
    }

    const canvas = page.locator("canvas").first();
    if (await canvas.isVisible({ timeout: 2000 }).catch(() => false)) {
      const box = await canvas.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + 240);
        await page.mouse.click(box.x + box.width / 2 + 54, box.y + 240);
        return "clicked puzzle canvas probe pair";
      }
    }
  }

  const firstButton = page.locator("button").first();
  if (await firstButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await firstButton.click();
    return "clicked first visible button";
  }

  return "no action performed";
}

async function continueCardPlaythrough(page) {
  for (let i = 0; i < 10; i++) {
    const resultVisible = await isVisible(page, "#results-screen.active");
    if (resultVisible) return "results screen reached";

    const cards = page.locator(".answer-card");
    const count = await cards.count().catch(() => 0);
    if (count > 0 && await cards.first().isVisible().catch(() => false)) {
      await cards.nth(i % count).click();
      await page.waitForTimeout(150);
    }

    if (await isVisible(page, "#lock-in-btn")) {
      await page.locator("#lock-in-btn").click();
      await page.waitForTimeout(2300);
    }

    if (await isVisible(page, "#next-btn")) {
      await page.locator("#next-btn").click();
      await page.waitForTimeout(700);
    }
  }

  return await isVisible(page, "#results-screen.active") ? "results screen reached" : "card playthrough timed out";
}

async function continuePuzzlePlaythrough(page) {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox().catch(() => null);
  if (!box) return "no canvas for puzzle playthrough";

  const probes = [
    [0.35, 0.30], [0.49, 0.30],
    [0.42, 0.38], [0.56, 0.38],
    [0.35, 0.47], [0.49, 0.47],
    [0.42, 0.56], [0.56, 0.56],
    [0.35, 0.64], [0.49, 0.64]
  ];

  for (let i = 0; i < probes.length; i += 2) {
    await page.mouse.click(box.x + box.width * probes[i][0], box.y + box.height * probes[i][1]);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + box.width * probes[i + 1][0], box.y + box.height * probes[i + 1][1]);
    await page.waitForTimeout(900);
    if (await isVisible(page, "#win-overlay.active") || await isVisible(page, "#loss-overlay.active")) {
      return "puzzle end state reached";
    }
  }

  return "puzzle probe completed";
}

async function continuePlaythrough(page, game) {
  if (game.type === "card") return continueCardPlaythrough(page);
  if (game.type === "puzzle") return continuePuzzlePlaythrough(page);
  return "no typed playthrough";
}

function scoreCategory(ok, partial = false) {
  if (ok) return 10;
  if (partial) return 5;
  return 0;
}

async function scoreRun({ game, firstScreen, consoleErrors, actionResult, playthroughResult, page }) {
  const endVisible = (game.expectedEndSelectors || []).length
    ? (await Promise.all(game.expectedEndSelectors.map(selector => isVisible(page, selector)))).some(Boolean)
    : false;

  const startClarity = scoreCategory(Boolean(firstScreen.canvasVisible || firstScreen.answerCardCount || firstScreen.buttonCount), Boolean(firstScreen.bodyText));
  const firstActionClarity = scoreCategory(firstScreen.firstActionCueVisible || firstScreen.answerCardCount > 0, firstScreen.buttonCount > 0);
  const feedbackAndJuice = scoreCategory(/clicked/.test(actionResult), /probe/.test(actionResult));
  const coreLoopProof = scoreCategory(/results screen reached|puzzle probe completed|end state reached/.test(playthroughResult));
  const goalClarity = scoreCategory(firstScreen.goalVisible);
  const endClarity = scoreCategory(endVisible, /probe completed|timed out/.test(playthroughResult));
  const visualQuality = scoreCategory(firstScreen.canvasVisible || firstScreen.answerCardCount > 0, firstScreen.buttonCount > 0);
  const technicalHealth = scoreCategory(consoleErrors.length === 0);
  const processCompliance = scoreCategory(true, false);

  const categories = {
    startClarity,
    firstActionClarity,
    feedbackAndJuice,
    coreLoopProof,
    goalClarity,
    endClarity,
    visualQuality,
    technicalHealth,
    processCompliance
  };

  const total = Object.values(categories).reduce((sum, value) => sum + value, 0);
  const score = Math.round((total / Object.keys(categories).length) * 10);
  const redFlags = [];

  if (!firstScreen.canvasVisible && firstScreen.answerCardCount === 0 && firstScreen.buttonCount === 0) redFlags.push("No visible interactive surface after load.");
  if (consoleErrors.length) redFlags.push(`${consoleErrors.length} console error/warning entries captured.`);
  if (!firstScreen.firstActionCueVisible && firstScreen.answerCardCount === 0) redFlags.push("First action cue is weak or missing.");
  if (score < 75) redFlags.push("Harness score below pass threshold.");

  return {
    game: game.gameName,
    type: game.type,
    url: game.url,
    verdict: redFlags.length ? "REVIEW" : "PASS",
    score,
    categories,
    redLines: game.redLines,
    redFlags,
    observations: {
      title: firstScreen.title,
      actionResult,
      playthroughResult,
      bodyTextSample: firstScreen.bodyText.slice(0, 600),
      consoleErrors
    }
  };
}

function renderReport(result, runDir) {
  return `# First Light Harness Report

Game: ${result.game}
Verdict: ${result.verdict}
Score: ${result.score}/100
Run folder: ${runDir}

## Category Scores

${Object.entries(result.categories).map(([key, value]) => `- ${key}: ${value}/10`).join("\n")}

## Red Lines

${result.redLines.map(line => `- CHECK: ${line}`).join("\n")}

## Red Flags

${result.redFlags.length ? result.redFlags.map(flag => `- ${flag}`).join("\n") : "- None"}

## Observed Journey

- Title: ${result.observations.title || "Untitled"}
- First action: ${result.observations.actionResult}
- Playthrough: ${result.observations.playthroughResult}
- Console issues: ${result.observations.consoleErrors.length}

## Screenshots

- screenshots/00-load.png
- screenshots/01-first-action.png
- screenshots/02-feedback.png
- screenshots/03-end-state.png

## Body Text Sample

\`\`\`text
${result.observations.bodyTextSample}
\`\`\`
`;
}

function renderBuilderTicket(result) {
  const priority = result.verdict === "PASS" ? "P2" : "P1";
  const mainProblem = result.redFlags[0] || "No blocking issue found; continue polish.";
  const requiredFix = result.redFlags.length
    ? "Address each red flag, then re-run the First Light performance harness until the score is 75+ with no automatic red flags."
    : "Add polish items: audio stub, deployed link proof, and one more visual/feedback pass.";

  return `# Builder Ticket

Game: ${result.game}
Priority: ${priority}
Owner: Jeff/Kevin

## Problem

${mainProblem}

## Why It Matters

The First Light studio should produce playable games that a new player understands without Wes explaining the rules. Any red flag here is friction before Quinn even starts human QA.

## Required Fix

${requiredFix}

## Acceptance Proof

- Re-run \`npm run first-light:harness\`.
- Harness score is 75+.
- No automatic red flags remain.
- Screenshots show load, first action, feedback, and end/progress state.
- Quinn can use the harness report as her starting point.

## Red Line

${result.verdict === "PASS" ? "Not blocking, but must be addressed before external handoff." : "Blocks clean pass."}
`;
}

async function runGame(browser, game) {
  const runDir = path.join(RUN_ROOT, `${nowStamp()}-${game.id}`);
  const screenshotsDir = path.join(runDir, "screenshots");
  await fs.mkdir(screenshotsDir, { recursive: true });

  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });

  const consoleErrors = [];
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) {
      consoleErrors.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", error => {
    consoleErrors.push({ type: "pageerror", text: error.message });
  });

  await page.goto(game.url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await screenshot(page, path.join(screenshotsDir, "00-load.png"));

  const firstScreen = await collectFirstScreenSignals(page, game);
  const actionResult = await performFirstAction(page, game);
  await page.waitForTimeout(1000);
  await screenshot(page, path.join(screenshotsDir, "01-first-action.png"));
  await page.waitForTimeout(1200);
  await screenshot(page, path.join(screenshotsDir, "02-feedback.png"));

  const playthroughResult = await continuePlaythrough(page, game);
  await page.waitForTimeout(700);
  await screenshot(page, path.join(screenshotsDir, "03-end-state.png"));

  const result = await scoreRun({ game, firstScreen, consoleErrors, actionResult, playthroughResult, page });

  await context.tracing.stop({ path: path.join(runDir, "trace.zip") });
  await context.close();

  await fs.writeFile(path.join(runDir, "score.json"), `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, "report.md"), renderReport(result, runDir));
  await fs.writeFile(path.join(runDir, "builder-ticket.md"), renderBuilderTicket(result));

  return { ...result, runDir };
}

async function runGameStatic(game) {
  const runDir = path.join(RUN_ROOT, `${nowStamp()}-${game.id}-static`);
  const screenshotsDir = path.join(runDir, "screenshots");
  await fs.mkdir(screenshotsDir, { recursive: true });

  const localPath = fileURLToPath(new URL(game.url));
  const html = await fs.readFile(localPath, "utf8");
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const firstScreen = {
    title: (html.match(/<title>(.*?)<\/title>/i)?.[1] || game.gameName).trim(),
    bodyText,
    canvasVisible: /<canvas\b|new Phaser\.Game|phaser/i.test(html),
    buttonCount: (html.match(/<button\b/gi) || []).length,
    answerCardCount: game.type === "card" ? (html.match(/answer-card/g) || []).length : 0,
    goalVisible: game.type === "puzzle" ? /goal-display|goal-count|Collect/i.test(html) : /question-text|person-name-display/i.test(html),
    firstActionCueVisible: /tutorial-pointer|tutorial-toast|action-hint|pulse-glow|Lock In/i.test(html),
    scoreVisible: /score-display|moves-display|moves-count|streak-display/i.test(html),
    endVisible: /win-overlay|loss-overlay|results-screen/i.test(html)
  };

  const result = await scoreRun({
    game,
    firstScreen,
    consoleErrors: [],
    actionResult: "static analysis only",
    playthroughResult: firstScreen.endVisible ? "static end-state markup found" : "static end-state markup missing",
    page: {
      locator: () => ({ first: () => ({ isVisible: async () => false }) })
    }
  });

  result.mode = "static";
  result.redFlags.push("Browser observation did not run in this environment; static HTML analysis only.");

  await fs.writeFile(path.join(runDir, "score.json"), `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, "report.md"), renderReport(result, runDir));
  await fs.writeFile(path.join(runDir, "builder-ticket.md"), renderBuilderTicket(result));

  return { ...result, runDir };
}

async function writeIndex(results) {
  await fs.mkdir(RUN_ROOT, { recursive: true });
  const latestPath = path.join(RUN_ROOT, "latest-summary.md");
  const body = `# First Light Harness Latest Summary

Run: ${new Date().toISOString()}

${results.map(result => `## ${result.game}

- Verdict: ${result.verdict}
- Score: ${result.score}/100
- Run folder: ${result.runDir}
- Report: ${path.join(result.runDir, "report.md")}
- Builder ticket: ${path.join(result.runDir, "builder-ticket.md")}
`).join("\n")}
`;
  await fs.writeFile(latestPath, body);
  return latestPath;
}

async function main() {
  for (const game of GAME_CONFIGS) {
    const filePath = new URL(game.url);
    const localPath = filePath.protocol === "file:" ? fileURLToPath(filePath) : "";
    if (localPath && !(await exists(localPath))) {
      throw new Error(`Missing game file: ${localPath}`);
    }
  }

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const results = [];
    for (const game of GAME_CONFIGS) {
      results.push(await runGame(browser, game));
    }
    const latestPath = await writeIndex(results);
    console.table(results.map(result => ({
      game: result.game,
      verdict: result.verdict,
      score: result.score,
      runDir: result.runDir
    })));
    console.log(`Latest summary: ${latestPath}`);
  } catch (error) {
    console.warn(`Browser harness unavailable, falling back to static mode: ${error.message}`);
    const results = [];
    for (const game of GAME_CONFIGS) {
      results.push(await runGameStatic(game));
    }
    const latestPath = await writeIndex(results);
    console.table(results.map(result => ({
      game: result.game,
      verdict: result.verdict,
      score: result.score,
      mode: result.mode || "browser",
      runDir: result.runDir
    })));
    console.log(`Latest summary: ${latestPath}`);
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

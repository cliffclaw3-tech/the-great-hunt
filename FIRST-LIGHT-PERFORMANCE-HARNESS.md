# First Light Performance Harness

Purpose: observe a playable game prototype, score whether it feels understandable and alive, then produce precise fix tickets for the next build pass.

This is not a replacement for Quinn. It is the machine pass before Quinn: it catches obvious friction, missing feedback, broken screens, weak tutorials, console errors, and process misses so human QA can focus on judgment.

## Core Idea

Playwright supplies the eyes and hands.

First Light supplies the taste, scoring, and builder tickets.

Every prototype should go through this loop:

1. Open the game.
2. Capture first impression screenshots.
3. Perform a short scripted playthrough.
4. Capture console errors, timing, screenshots, and optional trace/video.
5. Score the game against the First Light rubric.
6. Write a producer report.
7. Write a builder ticket for Jeff/Kevin.
8. Re-run after fixes and compare score changes.

## Inputs

Required:
- Game name
- Local file path or deployed URL
- Game type: puzzle, card, platformer, runner, strategy, social, etc.
- Nova brief path
- Jeff build plan path
- Quinn QA path, if one exists

Optional:
- Red-line list
- Reference game names
- Expected first action
- Expected win condition
- Expected loss condition
- Target viewport, usually phone portrait

Example:

```json
{
  "gameName": "Royal Gems",
  "url": "file:///Users/wes/.openclaw/workspace-main/games/benchmark-a-puzzle/index.html",
  "type": "puzzle",
  "viewport": { "width": 390, "height": 844 },
  "novaBrief": "/Users/wes/.openclaw/workspace-game/first-light-benchmark-nova-brief.md",
  "buildPlan": "/Users/wes/.openclaw/workspace-jeff/tasks/first-light-benchmark-build-plan.md",
  "redLines": [
    "Board refills with animated falling tiles",
    "Every match has burst, particles, and score pop",
    "Goal counter is always visible and reactive"
  ]
}
```

## Outputs

Each run writes a folder:

```text
first-light-harness-runs/
  2026-07-02-royal-gems/
    report.md
    builder-ticket.md
    score.json
    screenshots/
      00-load.png
      01-first-action.png
      02-feedback.png
      03-win-or-loss.png
    trace.zip
```

## Scoring Rubric

Score each category 0-10.

### 1. Start Clarity

Question: Can a new player understand where they are and what kind of game this is within 5 seconds?

Signals:
- Main play area visible
- No blank screen
- No confusing setup wall
- Game title or context visible enough
- First action area is obvious

Fail examples:
- Empty board
- Hidden controls
- No question/objective
- Desktop layout on phone viewport

### 2. First Action Clarity

Question: Does the player know what to tap, drag, select, or press first?

Signals:
- Tutorial pointer, highlighted legal action, pulsing card, or clear CTA
- No competing primary actions
- First move teaches the real mechanic, not a false mental model

Fail examples:
- Tutorial points to only two tiles when the real mechanic clears a whole cluster
- Lock In button appears without explaining the two-step selection flow
- Player can tap many things but none feel intended

### 3. Feedback And Juice

Question: Does every important action visibly respond?

Signals:
- Tap response
- Selection state
- Animation
- Particles or score pop where appropriate
- Error/no feedback for invalid actions
- No dead clicks

Fail examples:
- Tiles disappear silently
- Cards reveal with no flip or drama
- Score changes but player does not feel it
- Same animation for correct and incorrect outcomes

### 4. Core Loop Proof

Question: Can the harness complete one meaningful loop?

Signals:
- Puzzle: action -> clear/move -> refill -> progress
- Card: choose -> lock -> reveal -> score -> next question
- Runner: start -> avoid/collect -> fail/retry
- Strategy: choose -> resolve -> state changes

Fail examples:
- Static mockup
- One click changes text but no loop
- No progression after first action

### 5. Goal And Progress Clarity

Question: Does the player know what they are trying to accomplish?

Signals:
- Goal counter
- Score
- Moves/time/resource
- Progress feedback
- End condition

Fail examples:
- Player wins with no warning
- Player loses without knowing why
- Goal exists in code but not on screen

### 6. Win/Loss Or Round End

Question: Does the game clearly end a round or level?

Signals:
- Win state
- Loss/retry state
- Results screen
- Clear next action
- Celebration or proximity message

Fail examples:
- Game just stops
- Button says Next Level but restarts the same thing with no explanation
- Result math is wrong

### 7. Visual Quality

Question: Does it look intentional enough for Wes to show as evidence?

Signals:
- Consistent layout
- Mobile-first proportions
- Visual hierarchy
- No generic gray boxes
- No accidental overlap
- Art style matches the reference target

Fail examples:
- Placeholder rectangles
- Text cramped or clipped
- Work area boxes blocking the game
- One-note UI with no product feel

### 8. Technical Health

Question: Does the prototype run cleanly?

Signals:
- No console errors
- No missing assets
- No uncaught exceptions
- No stalled loading
- No obvious layout overflow on target viewport

Fail examples:
- JS error after first tap
- CDN fails without fallback
- Canvas blank
- Buttons hidden below viewport

### 9. Process Compliance

Question: Did the team follow the First Light chain?

Required order:
Jett research -> Nova translation -> Jeff plan -> Kevin build -> Quinn QA -> Cliff pass/fail

Fail examples:
- Jeff builds before Nova brief exists
- Kevin unavailable and fallback is not flagged
- Quinn QA missing
- No deployed link

## Automatic Red Flags

Any of these should force a Research/Fix ticket instead of a pass:

- Blank screen after 5 seconds
- Console error on load
- No visible first action
- No response to first valid tap/click
- No win/loss/round-end path
- Game cannot be opened by URL
- Prototype only exists as a local file when the deliverable requires public review
- Red line from Nova is missed
- QA says "conditional pass" and no fix pass exists

## Playwright Observation Plan

Minimum run:

1. Launch browser in phone viewport.
2. Open URL or local file.
3. Wait 2 seconds.
4. Screenshot `00-load.png`.
5. Record console errors.
6. Locate likely interactive elements:
   - buttons
   - answer cards
   - canvas
   - visible tutorial pointer
   - selected states
7. Perform first action.
8. Screenshot `01-first-action.png`.
9. Wait for animation.
10. Screenshot `02-feedback.png`.
11. Continue until either:
   - win screen
   - loss screen
   - result screen
   - timeout
12. Screenshot `03-win-or-loss.png`.
13. Write score and report.

## Suggested Script Skeleton

```js
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");

async function runHarness(config) {
  const runDir = path.join("first-light-harness-runs", `${Date.now()}-${slug(config.gameName)}`);
  await fs.mkdir(path.join(runDir, "screenshots"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: config.viewport || { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });

  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const consoleErrors = [];

  page.on("console", msg => {
    if (["error", "warning"].includes(msg.type())) {
      consoleErrors.push({ type: msg.type(), text: msg.text() });
    }
  });

  await page.goto(config.url);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(runDir, "screenshots", "00-load.png"), fullPage: true });

  const observations = await observeFirstScreen(page);
  await performFirstAction(page, config);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(runDir, "screenshots", "01-first-action.png"), fullPage: true });

  await continuePlaythrough(page, config);
  await page.screenshot({ path: path.join(runDir, "screenshots", "03-end-state.png"), fullPage: true });

  await context.tracing.stop({ path: path.join(runDir, "trace.zip") });
  await browser.close();

  const score = scoreRun({ observations, consoleErrors, config });
  await fs.writeFile(path.join(runDir, "score.json"), JSON.stringify(score, null, 2));
  await fs.writeFile(path.join(runDir, "report.md"), renderReport(score));
  await fs.writeFile(path.join(runDir, "builder-ticket.md"), renderBuilderTicket(score));
}
```

## Producer Report Format

```md
# First Light Harness Report

Game:
Run:
Verdict:
Score:

## What Worked
- ...

## What Failed
- ...

## Red Lines
- PASS/FAIL ...

## Player Journey
1. Load:
2. First action:
3. Feedback:
4. End state:

## Screenshots
- 00-load.png
- 01-first-action.png
- 02-feedback.png
- 03-end-state.png

## Builder Ticket
See builder-ticket.md
```

## Builder Ticket Format

```md
# Builder Ticket

Game:
Priority:
Owner:

## Problem
What the harness observed.

## Why It Matters
What player confusion or quality issue this causes.

## Required Fix
Concrete behavior to implement.

## Acceptance Proof
How the harness/Quinn can verify it.

## Red Line
Whether this blocks pass/fail.
```

## First Games To Test

Game A:
`/Users/wes/.openclaw/workspace-main/games/benchmark-a-puzzle/index.html`

Game B:
`/Users/wes/.openclaw/workspace-main/games/benchmark-b-card/index.html`

## First Improvements To Automate

1. Screenshot every prototype at 390x844.
2. Fail if there is a console error.
3. Fail if no visible interactive element exists after 5 seconds.
4. Fail if first action causes no visual change.
5. Fail if no end state appears within a scripted playthrough.
6. Produce a fix ticket in Jeff/Kevin language.
7. Compare latest run against prior run.

## North Star

The harness should make the team better every pass.

It should not say "bad game."

It should say:

"The player does not know the first action. Add a visible first-action cue. Prove it with screenshot 01 and a passing first-action clarity score."

## Current Implementation

Starter runner:

`/Users/wes/Projects/The Great Hunt/tools/first-light-performance-harness.js`

Commands:

```bash
npm run first-light:harness
npm run first-light:serve
```

Deploy-ready benchmark copies:

```text
/Users/wes/Projects/The Great Hunt/first-light-studio-deploy/benchmarks/index.html
/Users/wes/Projects/The Great Hunt/first-light-studio-deploy/benchmarks/royal-gems/index.html
/Users/wes/Projects/The Great Hunt/first-light-studio-deploy/benchmarks/do-you-know-them/index.html
```

Harness output:

```text
/Users/wes/Projects/The Great Hunt/first-light-harness-runs/latest-summary.md
```

## Updated Done Definition For Cliff's Team

A First Light game is not done until all of these are true:

1. Jett produced the reference/research packet.
2. Nova produced the game-director brief after reading Jett's packet.
3. Jeff produced the build plan after reading Jett and Nova.
4. Kevin produced or updated the playable build.
5. The prototype is available through a deployable path or live URL.
6. `npm run first-light:harness` has been run.
7. The harness report and builder ticket exist.
8. Quinn QA has reviewed the playable build and the harness report.
9. Cliff filed final pass/fail.

If any step is skipped, the status is not PASS. It is either PARTIAL PASS or PROCESS FAIL.

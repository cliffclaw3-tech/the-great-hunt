const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const port = 49173;
const base = `http://127.0.0.1:${port}`;
const betaCode = "HUNT2026";
const testerCode = `WO060-${Date.now().toString(36).toUpperCase()}`;
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
const dataFiles = [
  path.join(root, "data", "beta-scout.json"),
  path.join(root, "data", "finds.json"),
  path.join(root, "data", "activity-events.json")
];

async function readMaybe(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function restore(backups) {
  await Promise.all(Object.entries(backups).map(async ([file, content]) => {
    if (content === null) {
      await fs.rm(file, { force: true });
    } else {
      await fs.writeFile(file, content);
    }
  }));
}

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    signal: AbortSignal.timeout(1500),
    ...options
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {}
  return { response, body, text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(child) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const { response } = await request("/api/beta/status");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("server did not start");
}

async function main() {
  console.log("WO-060 check starting");
  const backups = Object.fromEntries(await Promise.all(dataFiles.map(async file => [file, await readMaybe(file)])));
  console.log("WO-060 data backups captured");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      BETA_ACCESS_CODE: betaCode,
      APP_PUBLIC_URL: "https://thegreathunt.io",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });

  try {
    await waitForServer(child);
    console.log("WO-060 local server ready");

    const signupPage = await request("/");
    assert(
      signupPage.response.ok && (
        signupPage.text.includes("id=\"betaAgreement\"") ||
        signupPage.text.includes("id=\"betaAgreementAccepted\"")
      ),
      "signup beta agreement checkbox missing"
    );

    const adminPage = await request("/admin/beta-scout");
    assert(adminPage.response.ok && adminPage.text.includes("Beta Scout"), "admin panel missing at /admin/beta-scout");

    const health = await request("/api/health");
    assert(health.response.ok && health.body.betaScout === true, "health betaScout flag missing");
    assert(JSON.stringify(health.body).includes("beta-scout=true"), "health check does not show beta-scout=true");

    const headers = { "Content-Type": "application/json", "X-Beta-Access-Code": betaCode };
    const tester = await request("/api/beta-scout/testers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "WO-060 Tester",
        email: "wo060@example.com",
        code: testerCode,
        notes: "Automated done-bar tester"
      })
    });
    assert(tester.response.status === 201 && tester.body.code === testerCode, "per-tester invite code not created");

    const rejectedAgreement = await request("/api/beta/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: testerCode })
    });
    assert(rejectedAgreement.response.status === 400, "beta agreement was not enforced");

    const accepted = await request("/api/beta/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: testerCode, agreementAccepted: true })
    });
    assert(accepted.response.ok && accepted.body.accepted && accepted.body.betaScout, "per-tester invite code did not unlock beta");

    const testerHeaders = { "Content-Type": "application/json", "X-Beta-Access-Code": testerCode };
    await request("/api/activity", {
      method: "POST",
      headers: testerHeaders,
      body: JSON.stringify({ type: "app-opened", success: true })
    });
    await request("/api/activity", {
      method: "POST",
      headers: testerHeaders,
      body: JSON.stringify({ type: "lookup-result", query: "case knife", resultTitle: "Case knife", success: true })
    });
    const saved = await request("/api/finds", {
      method: "POST",
      headers: testerHeaders,
      body: JSON.stringify({
        title: "Case knife",
        category: "Knives",
        ground: "Estate sale",
        source: "WO-060 check",
        ask: 25,
        comps: 3,
        confidence: 82,
        betaFeedback: "useful",
        betaNotes: "Automated tester feedback"
      })
    });
    assert(saved.response.status === 201 && saved.body.betaTesterCode === testerCode, "saved find was not tagged to tester code");

    const summary = await request("/api/beta-scout", { headers: testerHeaders });
    const row = summary.body.testers.find(item => item.code === testerCode);
    assert(row, "tester missing from beta scout summary");
    assert(row.score.signedUp && row.score.opened && row.score.tested && row.score.saved && row.score.feedback, "tester scoring did not cover signed-up/opened/tested/saved/feedback");

    console.log("WO-060 check PASS");
    console.log(`signup agreement: ${signupPage.response.status}`);
    console.log(`admin panel: ${adminPage.response.status}`);
    console.log(`health beta-scout=true: ${health.body.betaScout}`);
    console.log(`tester code functional: ${testerCode}`);
    console.log(`score signed-up/opened/tested/saved/feedback: ${JSON.stringify(row.score)}`);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    await restore(backups);
    if (process.env.WO060_DEBUG_SERVER === "1") {
      console.error(stdout);
      console.error(stderr);
    }
  }
}

const run = main();
const keepAlive = setInterval(() => {}, 1000);

run.then(() => {
  clearInterval(keepAlive);
}).catch(error => {
  clearInterval(keepAlive);
  console.error(`WO-060 check FAIL: ${error.message}`);
  process.exit(1);
});

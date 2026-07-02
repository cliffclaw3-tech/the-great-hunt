const { spawnSync } = require("node:child_process");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("--check-only");
const skipAudit = args.has("--skip-audit");

function run(command, commandArgs, options = {}) {
  const label = [command, ...commandArgs].join(" ");
  console.log(`\n> ${label}`);
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: false,
    ...options
  });

  if (result.error) {
    console.error(`\nCommand could not start: ${label}`);
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\nCommand failed: ${label}`);
    process.exit(result.status || 1);
  }
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

function requireRailwayAuth() {
  const status = capture("railway", ["status"]);
  if (!status.ok) {
    const errorText = `${status.stderr}\n${status.stdout}`;
    console.error("\nRailway is not ready for agent deploys.");
    console.error(status.stderr || status.stdout || "Railway status failed.");
    if (/dns error|failed to lookup|could not resolve|network|fetch failed/i.test(errorText)) {
      console.error("\nFix: this looks like network/DNS access is blocked or unavailable for the current agent session. Retry from a network-enabled terminal/session.");
    } else if (/unauthorized|invalid_grant|login/i.test(errorText)) {
      console.error("\nFix: run `railway login --browserless` once on this machine, then rerun this deploy command.");
    } else {
      console.error("\nFix: run `railway status` manually to see whether this is auth, project link, or Railway availability.");
    }
    process.exit(1);
  }

  console.log(status.stdout);
}

console.log("The Great Hunt Railway deploy guard");
console.log(dryRun ? "Mode: dry run, no production deploy" : "Mode: production deploy");

requireRailwayAuth();
run("npm", ["run", "check"]);
run("npm", ["run", "test:comp-quality"]);

if (!skipAudit) {
  run("npm", ["run", "audit:valuation"]);
}

if (dryRun) {
  console.log("\nDry run complete. Railway auth and safety checks passed. No deploy was started.");
  process.exit(0);
}

run("railway", ["up", "--service", "the-great-hunt", "--environment", "production", "--ci", "--message", "Agent-verified deploy"]);
console.log("\nDeploy command finished. Check https://thegreathunt.io/api/health after Railway completes the rollout.");

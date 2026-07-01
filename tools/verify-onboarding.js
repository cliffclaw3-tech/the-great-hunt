const baseUrl = (process.env.ONBOARDING_VERIFY_BASE_URL || "https://thegreathunt.io").replace(/\/$/, "");
const email = process.env.TEST_SIGNUP_EMAIL || `theshieldsteam+great-hunt-wo061-${Date.now()}@gmail.com`;
const betaCode = process.env.TEST_BETA_CODE || "HUNT2026";
const allowDryRun = process.env.ONBOARDING_VERIFY_ALLOW_DRY_RUN === "true";

function fail(message, detail) {
  console.error(`FAIL ${message}`);
  if (detail) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    fail(`Expected JSON from ${response.url}`, text.slice(0, 500));
  }
}

function assertScheduled72h(signup) {
  const createdAt = Date.parse(signup.onboarding?.welcome?.sentAt || new Date().toISOString());
  const scheduledAt = Date.parse(signup.onboarding?.day3?.scheduledAt || "");
  if (!Number.isFinite(scheduledAt)) fail("Email 2 scheduledAt is missing or invalid", signup);

  const hours = (scheduledAt - createdAt) / (60 * 60 * 1000);
  if (hours < 71.5 || hours > 72.5) {
    fail(`Email 2 is not scheduled 72h later; got ${hours.toFixed(2)}h`, signup);
  }
}

(async () => {
  const signupResponse = await fetch(`${baseUrl}/api/beta/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-beta-access-code": betaCode
    },
    body: JSON.stringify({
      name: "WO-061 Verifier",
      email,
      focus: "onboarding proof",
      code: betaCode,
      agreementAccepted: true,
      source: "wo-061-verifier"
    })
  });
  const signup = await readJson(signupResponse);

  if (!signupResponse.ok || !signup.accepted) {
    fail(`Signup did not trigger onboarding: HTTP ${signupResponse.status}`, signup);
  }
  if (!signup.onboarding?.welcome?.ok) fail("Email 1 was not accepted by the sender", signup);
  if (!signup.onboarding?.day3?.ok) fail("Email 2 was not accepted by the sender scheduler", signup);
  if ((signup.onboarding.welcome.dryRun || signup.onboarding.day3.dryRun) && !allowDryRun) {
    fail("Verifier hit dry-run email mode; production must use real SendGrid delivery", signup);
  }
  assertScheduled72h(signup);

  console.log("PASS The Great Hunt onboarding signup flow");
  console.log(`base_url=${baseUrl}`);
  console.log(`email=${email}`);
  console.log(`welcome_provider=${signup.onboarding.welcome.provider}`);
  console.log(`welcome_status=${signup.onboarding.welcome.status || "(accepted)"}`);
  console.log(`welcome_message_id=${signup.onboarding.welcome.messageId || "(accepted-no-id)"}`);
  console.log(`day3_status=${signup.onboarding.day3.status || "(accepted)"}`);
  console.log(`day3_scheduled_at=${signup.onboarding.day3.scheduledAt}`);
  console.log(`day3_delay_hours=${signup.onboarding.day3.delayHours}`);
})();

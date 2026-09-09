// One-off: send a single follow-up message into an existing scenario
// session (by sessionId), for patching a transcript that a turn's transient
// ModelError left short of its target city, without discarding an
// otherwise-good session's prior holds by starting a brand-new sessionId.
//
// Usage: node scripts/continue-scenario-session.mjs <sessionId> "<message>"
import { invoke, requireEnv, signIn } from "./lib/agentcore-invoke.mjs";

const region = process.env.AWS_REGION ?? "us-east-1";
const runtimeArn = requireEnv("RUNTIME_ARN");
const cognitoClientId = requireEnv("COGNITO_CLIENT_ID");
const testUserPasswordSecretArn = requireEnv("TEST_USER_PASSWORD_SECRET_ARN");
const testUserEmail = process.env.TEST_USER_EMAIL ?? "wayfarer-test-user@example.com";

async function main() {
  const [sessionId, message] = process.argv.slice(2);
  if (!sessionId || !message) {
    throw new Error('usage: node scripts/continue-scenario-session.mjs <sessionId> "<message>"');
  }

  const accessToken = await signIn({ region, cognitoClientId, testUserPasswordSecretArn, testUserEmail });
  console.log(`caller: ${message}`);
  const reply = await invoke({ region, runtimeArn, accessToken, sessionId, message });
  console.log(`concierge: ${reply}`);
}

main().catch((error) => {
  console.error("THREW:", error);
  process.exit(1);
});

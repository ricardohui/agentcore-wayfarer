// Evaluations' 3-transcript dataset (issue #23 / ADR-0007 / REQ-EVAL-004): each
// transcript is a real, live-generated session produced by driving the actual
// deployed Concierge Runtime through its Cognito-authenticated /invocations
// entry point with a steered multi-turn conversation - not hand-authored
// fixture JSON. Mirrors tools/concierge-ui/proxy/server.mjs's sign-in +
// invoke pattern (issue #17), scripted instead of interactive.
//
// Usage: node scripts/run-evaluation-scenarios.mjs [happy|over-budget|incomplete|all]
//
// Required env: RUNTIME_ARN, COGNITO_CLIENT_ID, TEST_USER_PASSWORD_SECRET_ARN
// Optional env: AWS_REGION (default us-east-1), TEST_USER_EMAIL (default the
// Identity construct's fixed test user)

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { invoke, requireEnv, signIn } from "./lib/agentcore-invoke.mjs";

const region = process.env.AWS_REGION ?? "us-east-1";
const runtimeArn = requireEnv("RUNTIME_ARN");
const cognitoClientId = requireEnv("COGNITO_CLIENT_ID");
const testUserPasswordSecretArn = requireEnv("TEST_USER_PASSWORD_SECRET_ARN");
const testUserEmail = process.env.TEST_USER_EMAIL ?? "wayfarer-test-user@example.com";

const RESULTS_FILE = "dist/_evaluations/scenario-sessions.json";

// Steered so the deterministic budget gate and the itinerary-quality LLM
// judge (evaluations-construct.ts) land on the outcome each transcript name
// promises. WAYFARER_SCENARIO_BUDGET_USD is $3800 (src/evaluations/scenario-budget.ts) -
// these messages state that figure explicitly so the happy-path scenario
// stays legibly under it and the over-budget one legibly blows past it.
// One city per turn - a single message asking for all 3 cities' search+hold
// (plus any Policy approval retries) at once reliably exceeds
// MAX_TOOL_USE_ROUNDS (bedrock-converse-model-client.ts caps a turn at 8
// tool-call rounds), producing a ModelError instead of a transcript. Each
// per-city turn pre-approves any Gated hold and tells the model to retry it
// in the same response rather than stopping to ask - that keeps a whole
// city's flight+hotel (with any approval retries) inside one turn's 8-round
// budget instead of needing a separate human turn per approval.
const AFFORDABLE_CITY_TURN = (city) =>
  `Now handle ${city}: search flights and hotels there, then hold the most affordable flight ` +
  `and the most affordable hotel option. If either hold comes back Gated needing approval ` +
  `because of its price, I'm pre-approving it right now - call approve-hold and retry that hold ` +
  `immediately in this same response, don't stop to ask me first. Keep going until ${city} has ` +
  `both a flight hold and a hotel hold.`;
const EXPENSIVE_CITY_TURN = (city) =>
  `Now handle ${city}: search flights and hotels there, then hold the most premium, most ` +
  `expensive flight and the most expensive hotel option, regardless of price. If either hold ` +
  `comes back Gated needing approval because of its price, I'm pre-approving it right now - call ` +
  `approve-hold and retry that hold immediately in this same response, don't stop to ask me ` +
  `first. Keep going until ${city} has both a flight hold and a hotel hold.`;

const FRESH_TRIP_NOTE =
  "This is a brand-new trip starting right now - nothing is held yet for this trip. Please " +
  "disregard any holds, bookings, or running total you recall from a past trip; only count " +
  "holds you actually place during this conversation.";

const SCENARIOS = {
  happy: [
    `I'm planning a trip to Tokyo, Paris, and New York. My total budget for all flights and ` +
      `hotels combined is $3800 - we'll go city by city so please only work on the city I name ` +
      `in each message. ${FRESH_TRIP_NOTE}`,
    AFFORDABLE_CITY_TURN("Tokyo"),
    AFFORDABLE_CITY_TURN("Paris"),
    AFFORDABLE_CITY_TURN("New York"),
    "Can you confirm: do all three cities now have both a flight hold and a hotel hold placed " +
      "during this conversation, and what's my current running total?",
  ],
  "over-budget": [
    `I'm planning a trip to Tokyo, Paris, and New York. Money is no object for this trip - ` +
      `we'll go city by city so please only work on the city I name in each message. ${FRESH_TRIP_NOTE}`,
    EXPENSIVE_CITY_TURN("Tokyo"),
    EXPENSIVE_CITY_TURN("Paris"),
    EXPENSIVE_CITY_TURN("New York"),
    "What's my current running total, and do all three cities have both a flight hold and a " +
      "hotel hold placed during this conversation now?",
  ],
  incomplete: [
    `I'm planning a trip to Tokyo, Paris, and New York. Let's start with just Tokyo for now - ` +
      `please search flights and hotels for Tokyo and hold the cheapest option of each. ${FRESH_TRIP_NOTE}`,
    "Yes, please go ahead and place both of those Tokyo holds now - I approve, whatever the price. " +
      "Once they're confirmed held, that's all I need for today - I'll come back later to sort out " +
      "Paris and New York, please don't search or hold anything for those two cities.",
  ],
};

async function main() {
  const requested = process.argv[2] ?? "all";
  const names = requested === "all" ? Object.keys(SCENARIOS) : [requested];
  for (const name of names) {
    if (!SCENARIOS[name]) {
      throw new Error(`unknown scenario "${name}" - expected one of: ${Object.keys(SCENARIOS).join(", ")}, all`);
    }
  }

  const accessToken = await signIn({ region, cognitoClientId, testUserPasswordSecretArn, testUserEmail });
  const sessions = {};

  for (const name of names) {
    console.log(`\n=== scenario: ${name} ===`);
    const sessionId = `wayfarer-eval-${name}-${randomUUID()}`;
    console.log(`sessionId: ${sessionId}`);
    for (const [index, message] of SCENARIOS[name].entries()) {
      console.log(`\n--- turn ${index + 1} ---`);
      console.log(`caller: ${message}`);
      const reply = await invoke({ region, runtimeArn, accessToken, sessionId, message });
      console.log(`concierge: ${reply}`);
    }
    sessions[name] = sessionId;
  }

  mkdirSync("dist/_evaluations", { recursive: true });
  writeFileSync(RESULTS_FILE, JSON.stringify(sessions, null, 2));
  console.log(`\nWrote session ids for [${Object.keys(sessions).join(", ")}] to ${RESULTS_FILE}`);
}

main().catch((error) => {
  console.error("THREW:", error);
  process.exit(1);
});

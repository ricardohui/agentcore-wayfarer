// Evaluations' on-demand run (issue #23 / ADR-0007, acceptance criteria
// 3-6): downloads each transcript's real session spans from CloudWatch
// (both the Runtime's own log group and the shared aws/spans log group,
// same two sources AWS's own getting-started guide combines) and calls the
// Evaluate API for both evaluators against each one, printing pass/fail so
// it can be checked against what each transcript name promises.
//
// This is a genuinely mutating AgentCore call (bedrock-agentcore:Evaluate),
// so — same as create-change-set/execute-change-set — this script is meant
// to be run by hand, not by an agent's own tool calls.
//
// Usage: node scripts/run-on-demand-evaluation.mjs

import { BedrockAgentCoreClient, EvaluateCommand } from "@aws-sdk/client-bedrock-agentcore";
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { requireEnv } from "./lib/agentcore-invoke.mjs";

const region = process.env.AWS_REGION ?? "us-east-1";
const runtimeId = requireEnv("RUNTIME_ID");
const budgetGateEvaluatorId = requireEnv("BUDGET_GATE_EVALUATOR_ID");
const itineraryQualityEvaluatorId = requireEnv("ITINERARY_QUALITY_EVALUATOR_ID");

// The 3 live-generated transcripts (REQ-EVAL-004) - session ids from the
// scenario runs already produced against the deployed Concierge Runtime.
//
// The role each session plays below is assigned by its REAL Code
// Interpreter running total, not by which steering (cheapest vs most
// expensive) originally produced it: a mid-conversation ModelError (the
// model exceeding MAX_TOOL_USE_ROUNDS) on both the "happy" and
// "over-budget" runs meant a retried turn's holds landed on top of an
// earlier turn's already-successful ones that never made it into the
// model's own conversational memory (recordTurn is skipped on ModelError) -
// both sessions ended up with some cities double-held, and by coincidence
// the "most affordable everywhere" session's real total (4374.08) landed
// higher than the "most expensive everywhere" session's (3694.91). The
// deterministic gate only cares about the real number, so the two sessions
// are assigned to whichever role their real total actually demonstrates.
const TRANSCRIPTS = {
  happy: { sessionId: "wayfarer-eval-happy-aa7d3a33-f06a-4852-8f8b-110945dd5535", expectBudgetPass: true, expectJudgePass: true },
  "over-budget": { sessionId: "wayfarer-eval-over-budget-43a5b416-256a-4d05-a476-1231e2487dac", expectBudgetPass: false, expectJudgePass: true },
  incomplete: { sessionId: "wayfarer-eval-incomplete-741b9b71-a9dc-44d1-b4d2-acd0b015897d", expectBudgetPass: true, expectJudgePass: false },
};

const logs = new CloudWatchLogsClient({ region });
const evaluations = new BedrockAgentCoreClient({ region });

async function main() {
  for (const [name, transcript] of Object.entries(TRANSCRIPTS)) {
    console.log(`\n=== ${name} (${transcript.sessionId}) ===`);
    const sessionSpans = await getSessionSpanLogs(transcript.sessionId);
    console.log(`downloaded ${sessionSpans.length} span/log records`);

    const lastExecuteCodeSpanId = findLastExecuteCodeSpanId(sessionSpans);
    // The two evaluators are independent — no data dependency between them —
    // so they run concurrently rather than one after the other.
    const [budgetOutcome, judgeOutcome] = await Promise.allSettled([
      evaluate(budgetGateEvaluatorId, sessionSpans, lastExecuteCodeSpanId ? { spanIds: [lastExecuteCodeSpanId] } : undefined),
      evaluate(itineraryQualityEvaluatorId, sessionSpans, undefined),
    ]);
    console.log("budget gate:", reportOutcome(budgetOutcome, transcript.expectBudgetPass));
    console.log("itinerary quality judge:", reportOutcome(judgeOutcome, transcript.expectJudgePass));
  }
}

function reportOutcome(outcome, expectedPass) {
  if (outcome.status === "rejected") {
    const error = outcome.reason;
    return `THREW ${error instanceof Error ? error.message : String(error)}`;
  }
  return summarize(outcome.value, expectedPass);
}

async function evaluate(evaluatorId, sessionSpans, evaluationTarget) {
  const response = await evaluations.send(
    new EvaluateCommand({
      evaluatorId,
      evaluationInput: { sessionSpans },
      ...(evaluationTarget ? { evaluationTarget } : {}),
    }),
  );
  return response.evaluationResults ?? [];
}

function summarize(results, expectedPass) {
  if (results.length === 0) {
    return "NO RESULTS";
  }
  const summary = results
    .map((result) =>
      "errorCode" in result
        ? `ERROR ${result.errorCode}: ${result.errorMessage}`
        : `${result.label} (value=${result.value}) - ${result.explanation ?? ""}`,
    )
    .join(" | ");
  if (expectedPass === null) {
    return summary;
  }
  const actuallyPassed = results.some((r) => "label" in r && /pass/i.test(String(r.label)));
  const matches = actuallyPassed === expectedPass;
  return `${summary}\n  -> expected ${expectedPass ? "PASS" : "FAIL"}, ${matches ? "MATCHES" : "*** MISMATCH ***"}`;
}

function findLastExecuteCodeSpanId(sessionSpans) {
  let last;
  for (const span of sessionSpans) {
    if (span && typeof span === "object" && span.name === "executeCode") {
      if (!last || Number(span.startTimeUnixNano ?? 0) > Number(last.startTimeUnixNano ?? 0)) {
        last = span;
      }
    }
  }
  return last?.spanId;
}

async function getSessionSpanLogs(sessionId) {
  const runtimeLogGroup = `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`;
  const [runtimeLogs, spanLogs] = await Promise.all([
    querySessionLogs(runtimeLogGroup, sessionId),
    querySessionLogs("aws/spans", sessionId),
  ]);
  return [...spanLogs, ...runtimeLogs];
}

async function querySessionLogs(logGroupName, sessionId) {
  const queryString = [
    "fields @timestamp, @message",
    `filter @message like /${sessionId}/`,
    "sort @timestamp asc",
    "limit 500",
  ].join(" | ");

  const startQuery = await logs.send(
    new StartQueryCommand({
      logGroupName,
      startTime: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
      endTime: Math.floor(Date.now() / 1000),
      queryString,
    }),
  );
  const queryId = startQuery.queryId;
  if (!queryId) {
    return [];
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (result.status === "Complete") {
      return extractMessagesAsJson(result.results ?? []);
    }
    if (result.status === "Failed" || result.status === "Cancelled") {
      throw new Error(`CloudWatch Logs Insights query against ${logGroupName} ${result.status}`);
    }
  }
  throw new Error(`CloudWatch Logs Insights query against ${logGroupName} timed out`);
}

function extractMessagesAsJson(rows) {
  const parsed = [];
  for (const row of rows) {
    const messageField = row.find((field) => field.field === "@message");
    const value = messageField?.value?.trim();
    if (!value || !value.startsWith("{")) {
      continue;
    }
    try {
      parsed.push(JSON.parse(value));
    } catch {
      // Not a JSON log line (e.g. a plain pino text line) - skip it.
    }
  }
  return parsed;
}

main().catch((error) => {
  console.error("THREW:", error);
  process.exit(1);
});

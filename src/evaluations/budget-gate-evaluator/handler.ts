import { WAYFARER_SCENARIO_BUDGET_USD } from "../scenario-budget";

// AgentCore's code-based-evaluator Lambda contract (issue #23 / ADR-0007):
// https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-based-evaluators.html
// AgentCore invokes this Lambda once per TOOL_CALL-level evaluation target
// with the session's OTEL spans and, when set, the specific span(s) under
// evaluation.
export type CodeBasedEvaluatorEvent = {
  readonly schemaVersion: string;
  readonly evaluatorId: string;
  readonly evaluatorName: string;
  readonly evaluationLevel: "TRACE" | "TOOL_CALL" | "SESSION";
  readonly evaluationInput: { readonly sessionSpans: readonly unknown[] };
  readonly evaluationReferenceInputs?: readonly unknown[];
  readonly evaluationTarget?: { readonly traceIds?: readonly string[]; readonly spanIds?: readonly string[] } | null;
};

export type CodeBasedEvaluatorSuccess = { readonly label: "PASS" | "FAIL"; readonly value: number; readonly explanation: string };
export type CodeBasedEvaluatorError = { readonly errorCode: string; readonly errorMessage: string };
export type CodeBasedEvaluatorResponse = CodeBasedEvaluatorSuccess | CodeBasedEvaluatorError;

// The candidate keys a span might carry its own identity under — AgentCore's
// exact OTEL span shape isn't pinned down by the Lambda contract docs, so
// this checks the field names its own code samples use (`traceId`) plus the
// obvious sibling for a span's own id, rather than assuming one.
const SPAN_ID_FIELDS = ["spanId", "span_id", "id"] as const;

// Code Interpreter's budget/currency math (issue #18) prints this exact
// shape as its executeCode stdout (see BudgetSnapshot / buildBudgetConversionScript
// in code-interpreter-budget-adapter.ts) — the Running total this gate reads
// is that JSON's `runningTotal` field, wherever OTEL ends up carrying it in
// a span's attributes.
function isBudgetSnapshotLike(value: unknown): value is { runningTotal: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "runningTotal" in value &&
    typeof (value as { runningTotal: unknown }).runningTotal === "number"
  );
}

// Recursively searches an arbitrary span (object/array/JSON-string-valued
// attribute — OTEL exporters vary in how deeply they nest and whether a
// value is already parsed or still a JSON string) for every Running total
// this session's Code Interpreter calls printed, returning the running
// totals found. Deliberately schema-agnostic: this project doesn't control
// AgentCore's OTEL span shape, so matching on "a JSON object that looks like
// a BudgetSnapshot" is more robust than hardcoding an attribute key that
// live verification (this ticket's own acceptance criteria) might disprove.
export function extractRunningTotals(spans: readonly unknown[]): number[] {
  const found: number[] = [];
  const visited = new Set<unknown>();

  function visit(value: unknown): void {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          // Not JSON — an ordinary string attribute, nothing to extract.
        }
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (isBudgetSnapshotLike(value)) {
      found.push(value.runningTotal);
    }
    for (const entry of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
      visit(entry);
    }
  }

  for (const span of spans) {
    visit(span);
  }
  return found;
}

function matchesTargetSpanId(span: unknown, spanIds: readonly string[]): boolean {
  if (typeof span !== "object" || span === null) {
    return false;
  }
  const record = span as Record<string, unknown>;
  return SPAN_ID_FIELDS.some((field) => typeof record[field] === "string" && spanIds.includes(record[field] as string));
}

// Narrows to the evaluation's target span(s) when AgentCore supplied one —
// falling back to every span in the session when none of them match any of
// SPAN_ID_FIELDS (rather than finding nothing), since the Running total's
// magnitude is what this gate judges, not which span produced it.
function spansInScope(event: CodeBasedEvaluatorEvent): readonly unknown[] {
  const spanIds = event.evaluationTarget?.spanIds;
  if (!spanIds || spanIds.length === 0) {
    return event.evaluationInput.sessionSpans;
  }
  const matched = event.evaluationInput.sessionSpans.filter((span) => matchesTargetSpanId(span, spanIds));
  return matched.length > 0 ? matched : event.evaluationInput.sessionSpans;
}

// The deterministic budget gate (issue #23 / ADR-0007): Running total <=
// WAYFARER_SCENARIO_BUDGET_USD. The Running total only ever grows across a
// session's holds (CodeInterpreterBudgetAdapter accumulates, never resets),
// so the highest figure any in-scope span reports is the session's final
// Running total — the number the Caller actually ended up committing to.
export function evaluateBudgetGate(event: CodeBasedEvaluatorEvent): CodeBasedEvaluatorResponse {
  const runningTotals = extractRunningTotals(spansInScope(event));
  if (runningTotals.length === 0) {
    return {
      errorCode: "NO_BUDGET_DATA",
      errorMessage: "no Code Interpreter Running total found in this session's spans",
    };
  }

  const finalRunningTotal = Math.max(...runningTotals);
  const withinBudget = finalRunningTotal <= WAYFARER_SCENARIO_BUDGET_USD;
  return {
    label: withinBudget ? "PASS" : "FAIL",
    value: withinBudget ? 1 : 0,
    explanation: withinBudget
      ? `Running total $${finalRunningTotal.toFixed(2)} is within the $${WAYFARER_SCENARIO_BUDGET_USD.toFixed(2)} budget.`
      : `Running total $${finalRunningTotal.toFixed(2)} exceeds the $${WAYFARER_SCENARIO_BUDGET_USD.toFixed(2)} budget.`,
  };
}

export async function handler(event: CodeBasedEvaluatorEvent): Promise<CodeBasedEvaluatorResponse> {
  return evaluateBudgetGate(event);
}

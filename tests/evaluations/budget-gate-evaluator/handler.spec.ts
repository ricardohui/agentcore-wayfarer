import { describe, expect, it } from "vitest";
import {
  evaluateBudgetGate,
  extractRunningTotals,
  type CodeBasedEvaluatorEvent,
} from "../../../src/evaluations/budget-gate-evaluator/handler";
import { WAYFARER_SCENARIO_BUDGET_USD } from "../../../src/evaluations/scenario-budget";

function anEvent(overrides: Partial<CodeBasedEvaluatorEvent> = {}): CodeBasedEvaluatorEvent {
  return {
    schemaVersion: "1.0",
    evaluatorId: "wayfarer-budget-gate",
    evaluatorName: "WayfarerBudgetGate",
    evaluationLevel: "TOOL_CALL",
    evaluationInput: { sessionSpans: [] },
    evaluationReferenceInputs: [],
    evaluationTarget: null,
    ...overrides,
  };
}

// A Code Interpreter tool-call span shaped the way BudgetSnapshot's
// stdout JSON (code-interpreter-budget-adapter.ts) would actually show up
// once OTEL carries it: the parsed object nested under an attribute, and a
// spanId sibling for evaluationTarget targeting.
function aCodeInterpreterSpan(spanId: string, runningTotal: number): unknown {
  return {
    spanId,
    name: "InvokeCodeInterpreter",
    attributes: {
      "gen_ai.tool.output": {
        runningTotal,
        breakdownByCity: { TOKYO: runningTotal },
        breakdownByCategory: { FLIGHT: runningTotal },
      },
    },
  };
}

// The same span shape, but with the JSON still serialized as a string
// attribute — some OTEL exporters carry structured output this way instead
// of as a nested object.
function aStringifiedCodeInterpreterSpan(spanId: string, runningTotal: number): unknown {
  return {
    spanId,
    name: "InvokeCodeInterpreter",
    attributes: {
      "gen_ai.tool.output": JSON.stringify({ runningTotal, breakdownByCity: {}, breakdownByCategory: {} }),
    },
  };
}

describe("extractRunningTotals", () => {
  it("finds a running total nested as a parsed object inside span attributes", () => {
    const totals = extractRunningTotals([aCodeInterpreterSpan("span-1", 450)]);

    expect(totals).toEqual([450]);
  });

  it("finds a running total serialized as a JSON string attribute", () => {
    const totals = extractRunningTotals([aStringifiedCodeInterpreterSpan("span-1", 900)]);

    expect(totals).toEqual([900]);
  });

  it("collects every running total across multiple spans", () => {
    const totals = extractRunningTotals([
      aCodeInterpreterSpan("span-1", 200),
      aCodeInterpreterSpan("span-2", 500),
      aCodeInterpreterSpan("span-3", 800),
    ]);

    expect(totals).toEqual([200, 500, 800]);
  });

  it("ignores spans with no Code Interpreter output", () => {
    const totals = extractRunningTotals([
      { spanId: "span-1", name: "InvokeGateway", attributes: { "gen_ai.tool.output": { holdId: "hold-1" } } },
    ]);

    expect(totals).toEqual([]);
  });
});

describe("evaluateBudgetGate", () => {
  it("PASSes when the session's final Running total is within the scenario budget", () => {
    const result = evaluateBudgetGate(
      anEvent({
        evaluationInput: {
          sessionSpans: [aCodeInterpreterSpan("span-1", 1000), aCodeInterpreterSpan("span-2", WAYFARER_SCENARIO_BUDGET_USD)],
        },
      }),
    );

    expect(result).toMatchObject({ label: "PASS", value: 1 });
  });

  it("FAILs when the session's final Running total exceeds the scenario budget", () => {
    const result = evaluateBudgetGate(
      anEvent({
        evaluationInput: {
          sessionSpans: [aCodeInterpreterSpan("span-1", 1000), aCodeInterpreterSpan("span-2", WAYFARER_SCENARIO_BUDGET_USD + 0.01)],
        },
      }),
    );

    expect(result).toMatchObject({ label: "FAIL", value: 0 });
  });

  it("judges the final (highest) running total, not the first one seen", () => {
    const overBudget = evaluateBudgetGate(
      anEvent({
        evaluationInput: {
          sessionSpans: [
            aCodeInterpreterSpan("span-1", WAYFARER_SCENARIO_BUDGET_USD + 500),
            aCodeInterpreterSpan("span-2", 100),
          ],
        },
      }),
    );

    expect(overBudget).toMatchObject({ label: "FAIL" });
  });

  it("narrows to the evaluationTarget's span when one is set", () => {
    const result = evaluateBudgetGate(
      anEvent({
        evaluationInput: {
          sessionSpans: [
            aCodeInterpreterSpan("span-1", WAYFARER_SCENARIO_BUDGET_USD + 999),
            aCodeInterpreterSpan("span-2", 100),
          ],
        },
        evaluationTarget: { spanIds: ["span-2"] },
      }),
    );

    expect(result).toMatchObject({ label: "PASS" });
  });

  it("falls back to every span when evaluationTarget names a spanId no span carries", () => {
    const result = evaluateBudgetGate(
      anEvent({
        evaluationInput: { sessionSpans: [aCodeInterpreterSpan("span-1", WAYFARER_SCENARIO_BUDGET_USD + 999)] },
        evaluationTarget: { spanIds: ["span-does-not-exist"] },
      }),
    );

    expect(result).toMatchObject({ label: "FAIL" });
  });

  it("returns a NO_BUDGET_DATA error when no span carries a Code Interpreter running total", () => {
    const result = evaluateBudgetGate(anEvent({ evaluationInput: { sessionSpans: [{ name: "InvokeGateway" }] } }));

    expect(result).toMatchObject({ errorCode: "NO_BUDGET_DATA" });
  });
});

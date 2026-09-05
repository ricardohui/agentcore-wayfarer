import { describe, expect, it } from "vitest";
import { buildBudgetConversionScript } from "../../../src/concierge/adapter/code-interpreter-budget-adapter";
import { aLocalPrice } from "../support/object-mothers";

// ADR-0004: the static mock rate table and the persistent-state pattern are
// both embedded in generated Python source, sent to a real sandbox — this
// tests the TypeScript generator directly, since nothing here can run the
// Python itself without hitting real AWS.
describe("buildBudgetConversionScript", () => {
  it("embeds the ADR-0004 mock rate table", () => {
    const script = buildBudgetConversionScript("TOKYO", "FLIGHT", aLocalPrice({ amount: 82000, currency: "JPY" }));

    expect(script).toContain('"JPY":0.0067');
    expect(script).toContain('"EUR":1.08');
    expect(script).toContain('"USD":1');
  });

  it("embeds the hold's city, category, and Local price", () => {
    const script = buildBudgetConversionScript("PARIS", "HOTEL", aLocalPrice({ amount: 150, currency: "EUR" }));

    expect(script).toContain('"city":"PARIS"');
    expect(script).toContain('"category":"HOTEL"');
    expect(script).toContain('"amount":150');
    expect(script).toContain('"currency":"EUR"');
  });

  it("only initializes the running-total state if it doesn't already exist in the sandbox's globals", () => {
    const script = buildBudgetConversionScript("TOKYO", "FLIGHT", aLocalPrice());

    expect(script).toContain("if '_wayfarer_budget_state' not in globals():");
  });

  it("raises for a currency the mock rate table doesn't cover", () => {
    const script = buildBudgetConversionScript("TOKYO", "FLIGHT", aLocalPrice({ currency: "XYZ" }));

    expect(script).toContain("raise ValueError");
  });

  it("prints the running total and both breakdowns as the final statement", () => {
    const script = buildBudgetConversionScript("TOKYO", "FLIGHT", aLocalPrice());
    const lastLine = script.trim().split("\n").pop();

    expect(script).toContain("print(json.dumps({");
    expect(lastLine).toBe("}))");
  });
});

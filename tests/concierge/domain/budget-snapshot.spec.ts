import { describe, expect, it } from "vitest";
import { BudgetSnapshot } from "../../../src/concierge/domain/budget-snapshot";

describe("BudgetSnapshot.parse", () => {
  it("parses a well-formed sandbox result", () => {
    const result = BudgetSnapshot.parse({
      runningTotal: 999.5,
      breakdownByCity: { TOKYO: 999.5 },
      breakdownByCategory: { FLIGHT: 549.5, HOTEL: 450 },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.toJSON()).toEqual({
      runningTotal: 999.5,
      breakdownByCity: { TOKYO: 999.5 },
      breakdownByCategory: { FLIGHT: 549.5, HOTEL: 450 },
    });
  });

  it("rejects a non-object payload", () => {
    const result = BudgetSnapshot.parse("not an object");

    expect(result).toEqual({
      ok: false,
      error: { type: "ValidationError", field: "budgetSnapshot", message: "must be an object" },
    });
  });

  it("rejects a negative running total", () => {
    const result = BudgetSnapshot.parse({ runningTotal: -1, breakdownByCity: {}, breakdownByCategory: {} });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.field).toBe("budgetSnapshot.runningTotal");
  });

  it("rejects a breakdown whose value isn't a finite number", () => {
    const result = BudgetSnapshot.parse({
      runningTotal: 100,
      breakdownByCity: { TOKYO: "a lot" },
      breakdownByCategory: {},
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.field).toBe("budgetSnapshot.breakdownByCity");
  });

  it("rejects a missing breakdown object", () => {
    const result = BudgetSnapshot.parse({ runningTotal: 100, breakdownByCategory: {} });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.field).toBe("budgetSnapshot.breakdownByCity");
  });
});

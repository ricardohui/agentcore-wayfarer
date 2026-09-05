import { describe, expect, it } from "vitest";
import { parseBudgetCategory } from "../../../src/concierge/domain/budget-category";

describe("parseBudgetCategory", () => {
  it.each(["FLIGHT", "HOTEL"])("accepts %s", (value) => {
    expect(parseBudgetCategory(value)).toEqual({ ok: true, value });
  });

  it("rejects a category outside the fixed set", () => {
    const result = parseBudgetCategory("CRUISE");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.type).toBe("ValidationError");
  });
});

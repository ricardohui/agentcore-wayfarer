import { describe, expect, it } from "vitest";
import { LocalPrice } from "../../../src/concierge/domain/local-price";

describe("LocalPrice", () => {
  it("parses a positive amount with a 3-letter uppercase currency code", () => {
    const result = LocalPrice.parse(1250, "JPY");

    expect(result).toEqual({ ok: true, value: expect.any(LocalPrice) });
    if (result.ok) {
      expect(result.value.toJSON()).toEqual({ amount: 1250, currency: "JPY" });
    }
  });

  it("rejects a non-positive amount", () => {
    const result = LocalPrice.parse(0, "USD");

    expect(result).toEqual({
      ok: false,
      error: { type: "ValidationError", field: "localPrice.amount", message: "must be a positive number" },
    });
  });

  it("rejects a currency code that isn't 3 uppercase letters", () => {
    const result = LocalPrice.parse(100, "usd");

    expect(result).toEqual({
      ok: false,
      error: {
        type: "ValidationError",
        field: "localPrice.currency",
        message: "must be a 3-letter uppercase ISO currency code",
      },
    });
  });
});

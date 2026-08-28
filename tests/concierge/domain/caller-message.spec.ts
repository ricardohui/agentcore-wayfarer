import { describe, expect, it } from "vitest";
import { parseCallerMessage } from "../../../src/concierge/domain/caller-message";

describe("parseCallerMessage", () => {
  it("accepts non-blank text", () => {
    const result = parseCallerMessage("Plan me a trip to Tokyo");

    expect(result).toEqual({ ok: true, value: "Plan me a trip to Tokyo" });
  });

  it("rejects blank text", () => {
    const result = parseCallerMessage("   ");

    expect(result).toEqual({
      ok: false,
      error: {
        type: "ValidationError",
        field: "callerMessage",
        message: "must not be blank",
      },
    });
  });

  it("accepts text at the maximum length", () => {
    const result = parseCallerMessage("a".repeat(4000));

    expect(result.ok).toBe(true);
  });

  it("rejects text over the maximum length", () => {
    const result = parseCallerMessage("a".repeat(4001));

    expect(result).toEqual({
      ok: false,
      error: {
        type: "ValidationError",
        field: "callerMessage",
        message: "must not exceed 4000 characters",
      },
    });
  });
});

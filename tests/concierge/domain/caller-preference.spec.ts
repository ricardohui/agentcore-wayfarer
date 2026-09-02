import { describe, expect, it } from "vitest";
import { parseCallerPreference } from "../../../src/concierge/domain/caller-preference";

describe("parseCallerPreference", () => {
  it("accepts non-blank text", () => {
    const result = parseCallerPreference("avoids red-eyes");

    expect(result).toEqual({ ok: true, value: "avoids red-eyes" });
  });

  it("rejects blank text", () => {
    const result = parseCallerPreference("   ");

    expect(result).toEqual({
      ok: false,
      error: { type: "ValidationError", field: "callerPreference", message: "must not be blank" },
    });
  });
});

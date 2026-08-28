import { describe, expect, it } from "vitest";
import { parseRuntimeSessionId } from "../../../src/concierge/domain/runtime-session-id";

describe("parseRuntimeSessionId", () => {
  it("accepts an id at least 33 characters long", () => {
    const result = parseRuntimeSessionId("a".repeat(33));

    expect(result).toEqual({ ok: true, value: "a".repeat(33) });
  });

  it("rejects an id shorter than 33 characters", () => {
    const result = parseRuntimeSessionId("too-short");

    expect(result).toEqual({
      ok: false,
      error: {
        type: "ValidationError",
        field: "runtimeSessionId",
        message: "must be at least 33 characters long",
      },
    });
  });

  it("rejects an empty id", () => {
    const result = parseRuntimeSessionId("");

    expect(result.ok).toBe(false);
  });
});

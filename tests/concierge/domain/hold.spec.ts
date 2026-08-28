import { describe, expect, it } from "vitest";
import { Hold } from "../../../src/concierge/domain/hold";

describe("Hold.parse", () => {
  it("parses a well-formed raw hold from Gateway", () => {
    const result = Hold.parse({
      holdId: "hold-1",
      status: "held",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.holdId).toBe("hold-1");
      expect(result.value.status).toBe("held");
      expect(result.value.expiresAt).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    }
  });

  it("rejects an unrecognized status", () => {
    const result = Hold.parse({
      holdId: "hold-1",
      status: "cancelled",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "hold.status" }),
    });
  });

  it("rejects an unparseable expiresAt", () => {
    const result = Hold.parse({
      holdId: "hold-1",
      status: "held",
      expiresAt: "not a date",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "hold.expiresAt" }),
    });
  });

  it("rejects a non-object raw value", () => {
    const result = Hold.parse(42);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "hold" }),
    });
  });
});

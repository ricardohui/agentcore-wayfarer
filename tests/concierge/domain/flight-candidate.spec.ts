import { describe, expect, it } from "vitest";
import { FlightCandidate } from "../../../src/concierge/domain/flight-candidate";

describe("FlightCandidate.parse", () => {
  it("parses a well-formed raw candidate from Gateway", () => {
    const result = FlightCandidate.parse({
      candidateId: "flight-1",
      destination: "TOKYO",
      airline: "ANA",
      price: { amount: 82000, currency: "JPY" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.candidateId).toBe("flight-1");
      expect(result.value.destination).toBe("TOKYO");
      expect(result.value.airline).toBe("ANA");
      expect(result.value.price.toJSON()).toEqual({ amount: 82000, currency: "JPY" });
    }
  });

  it("rejects a candidate for a city outside the 3 scenario cities", () => {
    const result = FlightCandidate.parse({
      candidateId: "flight-1",
      destination: "LONDON",
      airline: "ANA",
      price: { amount: 82000, currency: "JPY" },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "scenarioCity" }),
    });
  });

  it("rejects a candidate with a malformed price", () => {
    const result = FlightCandidate.parse({
      candidateId: "flight-1",
      destination: "TOKYO",
      airline: "ANA",
      price: { amount: -5, currency: "JPY" },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "localPrice.amount" }),
    });
  });

  it("rejects a non-object raw value", () => {
    const result = FlightCandidate.parse("not an object");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "flightCandidate" }),
    });
  });
});

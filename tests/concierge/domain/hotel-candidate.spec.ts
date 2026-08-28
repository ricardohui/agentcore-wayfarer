import { describe, expect, it } from "vitest";
import { HotelCandidate } from "../../../src/concierge/domain/hotel-candidate";

describe("HotelCandidate.parse", () => {
  it("parses a well-formed raw candidate from Gateway", () => {
    const result = HotelCandidate.parse({
      candidateId: "hotel-1",
      city: "PARIS",
      hotelName: "Hotel de Ville",
      price: { amount: 210, currency: "EUR" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.candidateId).toBe("hotel-1");
      expect(result.value.city).toBe("PARIS");
      expect(result.value.hotelName).toBe("Hotel de Ville");
      expect(result.value.price.toJSON()).toEqual({ amount: 210, currency: "EUR" });
    }
  });

  it("rejects a candidate for a city outside the 3 scenario cities", () => {
    const result = HotelCandidate.parse({
      candidateId: "hotel-1",
      city: "LONDON",
      hotelName: "Hotel de Ville",
      price: { amount: 210, currency: "EUR" },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "scenarioCity" }),
    });
  });

  it("rejects a non-object raw value", () => {
    const result = HotelCandidate.parse(null);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "hotelCandidate" }),
    });
  });
});

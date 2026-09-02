import { describe, expect, it } from "vitest";
import { err, ok } from "../../../src/concierge/domain/result";
import { BookingToolExecutor } from "../../../src/concierge/usecase/booking-tool-executor";
import { FakeBookingGatewayPort } from "../support/fakes";
import { aFlightCandidate, aHold, aHotelCandidate } from "../support/object-mothers";

describe("BookingToolExecutor", () => {
  it("dispatches a search-flights call to the port and serializes the candidates", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToSearchFlightsWith(ok([aFlightCandidate({ candidateId: "flight-1" })]));
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({
      toolUseId: "call-1",
      name: "search-flights",
      input: { destination: "TOKYO" },
    });

    expect(port.receivedSearchFlightsDestinations).toEqual(["TOKYO"]);
    expect(result).toEqual({
      toolUseId: "call-1",
      isError: false,
      // Nested under `candidates`, not a bare array — Bedrock's Converse API
      // requires toolResult.content[0].json to be a JSON object.
      content: {
        candidates: [
          {
            candidateId: "flight-1",
            destination: "TOKYO",
            airline: "ANA",
            price: { amount: 82000, currency: "JPY" },
          },
        ],
      },
    });
  });

  it("dispatches a search-hotels call to the port and serializes the candidates", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToSearchHotelsWith(ok([aHotelCandidate({ candidateId: "hotel-1" })]));
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({
      toolUseId: "call-2",
      name: "search-hotels",
      input: { city: "TOKYO" },
    });

    expect(port.receivedSearchHotelsCities).toEqual(["TOKYO"]);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({
      candidates: [
        {
          candidateId: "hotel-1",
          city: "TOKYO",
          hotelName: "Park Hyatt Tokyo",
          price: { amount: 45000, currency: "JPY" },
        },
      ],
    });
  });

  it("dispatches a hold-flight call to the port and serializes the hold", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToHoldFlightWith(ok(aHold({ holdId: "hold-1" })));
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({
      toolUseId: "call-3",
      name: "hold-flight",
      input: { candidateId: "flight-1" },
    });

    expect(port.receivedHoldFlightCandidateIds).toEqual(["flight-1"]);
    expect(result).toEqual({
      toolUseId: "call-3",
      isError: false,
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });
  });

  it("dispatches a hold-hotel call to the port and serializes the hold", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToHoldHotelWith(ok(aHold({ holdId: "hold-2" })));
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({
      toolUseId: "call-4",
      name: "hold-hotel",
      input: { candidateId: "hotel-1" },
    });

    expect(port.receivedHoldHotelCandidateIds).toEqual(["hotel-1"]);
    expect(result.content).toEqual({
      holdId: "hold-2",
      status: "held",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("surfaces a GatewayError from the port as a tool error result", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToSearchFlightsWith(err({ type: "GatewayUnavailable", message: "Lambda timed out" }));
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({
      toolUseId: "call-5",
      name: "search-flights",
      input: { destination: "PARIS" },
    });

    expect(result).toEqual({
      toolUseId: "call-5",
      isError: true,
      content: { error: "Lambda timed out" },
    });
  });

  it("rejects an unknown tool name without calling the port", async () => {
    const port = new FakeBookingGatewayPort();
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({ toolUseId: "call-6", name: "delete-everything", input: {} });

    expect(result.isError).toBe(true);
    expect(port.receivedSearchFlightsDestinations).toEqual([]);
    expect(port.receivedHoldFlightCandidateIds).toEqual([]);
  });

  it("rejects a search-flights call with a malformed destination without calling the port", async () => {
    const port = new FakeBookingGatewayPort();
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({
      toolUseId: "call-7",
      name: "search-flights",
      input: { destination: "ATLANTIS" },
    });

    expect(result.isError).toBe(true);
    expect(port.receivedSearchFlightsDestinations).toEqual([]);
  });

  it("rejects a hold-flight call with a missing candidateId without calling the port", async () => {
    const port = new FakeBookingGatewayPort();
    const executor = new BookingToolExecutor(port);

    const result = await executor.execute({ toolUseId: "call-8", name: "hold-flight", input: {} });

    expect(result.isError).toBe(true);
    expect(port.receivedHoldFlightCandidateIds).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { err, ok } from "../../../src/concierge/domain/result";
import { BookingToolExecutor } from "../../../src/concierge/usecase/booking-tool-executor";
import { FakeBookingGatewayPort, FakeBudgetPort, FakePriceCheckPort } from "../support/fakes";
import {
  aBudgetSnapshot,
  aFlightCandidate,
  aHold,
  aHotelCandidate,
  aLocalPrice,
  aRuntimeSessionId,
} from "../support/object-mothers";

describe("BookingToolExecutor", () => {
  it("dispatches a search-flights call to the port and serializes the candidates", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToSearchFlightsWith(ok([aFlightCandidate({ candidateId: "flight-1" })]));
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), new FakePriceCheckPort());

    const result = await executor.execute(
      { toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } },
      aRuntimeSessionId(),
    );

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
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), new FakePriceCheckPort());

    const result = await executor.execute(
      { toolUseId: "call-2", name: "search-hotels", input: { city: "TOKYO" } },
      aRuntimeSessionId(),
    );

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

  it("dispatches a hold-flight call to the port and serializes the hold, when the candidate was never searched", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToHoldFlightWith(ok(aHold({ holdId: "hold-1" })));
    const priceCheck = new FakePriceCheckPort();
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), priceCheck);

    const result = await executor.execute(
      { toolUseId: "call-3", name: "hold-flight", input: { candidateId: "flight-1" } },
      aRuntimeSessionId(),
    );

    expect(port.receivedHoldFlightCandidateIds).toEqual(["flight-1"]);
    expect(priceCheck.receivedCheckPriceCalls).toEqual([]);
    expect(result).toEqual({
      toolUseId: "call-3",
      isError: false,
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });
  });

  it("dispatches a hold-hotel call to the port and serializes the hold, when the candidate was never searched", async () => {
    const port = new FakeBookingGatewayPort();
    port.respondToHoldHotelWith(ok(aHold({ holdId: "hold-2" })));
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), new FakePriceCheckPort());

    const result = await executor.execute(
      { toolUseId: "call-4", name: "hold-hotel", input: { candidateId: "hotel-1" } },
      aRuntimeSessionId(),
    );

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
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), new FakePriceCheckPort());

    const result = await executor.execute(
      { toolUseId: "call-5", name: "search-flights", input: { destination: "PARIS" } },
      aRuntimeSessionId(),
    );

    expect(result).toEqual({
      toolUseId: "call-5",
      isError: true,
      content: { error: "Lambda timed out" },
    });
  });

  it("rejects an unknown tool name without calling the port", async () => {
    const port = new FakeBookingGatewayPort();
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), new FakePriceCheckPort());

    const result = await executor.execute(
      { toolUseId: "call-6", name: "delete-everything", input: {} },
      aRuntimeSessionId(),
    );

    expect(result.isError).toBe(true);
    expect(port.receivedSearchFlightsDestinations).toEqual([]);
    expect(port.receivedHoldFlightCandidateIds).toEqual([]);
  });

  it("rejects a search-flights call with a malformed destination without calling the port", async () => {
    const port = new FakeBookingGatewayPort();
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), new FakePriceCheckPort());

    const result = await executor.execute(
      { toolUseId: "call-7", name: "search-flights", input: { destination: "ATLANTIS" } },
      aRuntimeSessionId(),
    );

    expect(result.isError).toBe(true);
    expect(port.receivedSearchFlightsDestinations).toEqual([]);
  });

  it("rejects a hold-flight call with a missing candidateId without calling the port", async () => {
    const port = new FakeBookingGatewayPort();
    const executor = new BookingToolExecutor(port, new FakeBudgetPort(), new FakePriceCheckPort());

    const result = await executor.execute(
      { toolUseId: "call-8", name: "hold-flight", input: {} },
      aRuntimeSessionId(),
    );

    expect(result.isError).toBe(true);
    expect(port.receivedHoldFlightCandidateIds).toEqual([]);
  });

  describe("price-check + budget tracking (issue #19 / issue #18)", () => {
    it("runs a price-check for a searched flight candidate, holds at the Live price (not Quoted), and records it against the budget", async () => {
      const port = new FakeBookingGatewayPort();
      port.respondToSearchFlightsWith(ok([aFlightCandidate({ candidateId: "flight-1", destination: "TOKYO", price: { amount: 82000, currency: "JPY" } })]));
      port.respondToHoldFlightWith(ok(aHold({ holdId: "hold-1" })));
      const priceCheck = new FakePriceCheckPort();
      const livePrice = aLocalPrice({ amount: 79500, currency: "JPY" });
      priceCheck.respondToCheckPriceWith(ok(livePrice));
      const budget = new FakeBudgetPort();
      const snapshot = aBudgetSnapshot({ runningTotal: 532.65 });
      budget.respondToRecordHoldWith(ok(snapshot));
      const sessionId = aRuntimeSessionId();
      const executor = new BookingToolExecutor(port, budget, priceCheck);

      await executor.execute({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }, sessionId);
      const result = await executor.execute(
        { toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } },
        sessionId,
      );

      expect(priceCheck.receivedCheckPriceCalls).toEqual([{ candidateId: "flight-1", city: "TOKYO" }]);
      expect(budget.receivedRecordHoldCalls).toEqual([
        { sessionId, city: "TOKYO", category: "FLIGHT", price: expect.objectContaining({ amount: 79500, currency: "JPY" }) },
      ]);
      expect(result.content).toEqual({
        holdId: "hold-1",
        status: "held",
        expiresAt: "2026-09-01T00:00:00.000Z",
        livePrice: { amount: 79500, currency: "JPY" },
        budget: snapshot.toJSON(),
      });
    });

    it("runs a price-check for a searched hotel candidate and records the Live price (not Quoted) against the budget", async () => {
      const port = new FakeBookingGatewayPort();
      port.respondToSearchHotelsWith(ok([aHotelCandidate({ candidateId: "hotel-1", city: "PARIS", price: { amount: 150, currency: "EUR" } })]));
      port.respondToHoldHotelWith(ok(aHold({ holdId: "hold-2" })));
      const priceCheck = new FakePriceCheckPort();
      const livePrice = aLocalPrice({ amount: 162, currency: "EUR" });
      priceCheck.respondToCheckPriceWith(ok(livePrice));
      const budget = new FakeBudgetPort();
      budget.respondToRecordHoldWith(ok(aBudgetSnapshot()));
      const sessionId = aRuntimeSessionId();
      const executor = new BookingToolExecutor(port, budget, priceCheck);

      await executor.execute({ toolUseId: "call-1", name: "search-hotels", input: { city: "PARIS" } }, sessionId);
      const result = await executor.execute({ toolUseId: "call-2", name: "hold-hotel", input: { candidateId: "hotel-1" } }, sessionId);

      expect(priceCheck.receivedCheckPriceCalls).toEqual([{ candidateId: "hotel-1", city: "PARIS" }]);
      expect(budget.receivedRecordHoldCalls).toEqual([
        { sessionId, city: "PARIS", category: "HOTEL", price: expect.objectContaining({ amount: 162, currency: "EUR" }) },
      ]);
      expect(result.content).toMatchObject({ livePrice: { amount: 162, currency: "EUR" } });
    });

    it("blocks a hold-flight call when the price-check fails, without ever calling Gateway's hold-flight", async () => {
      const port = new FakeBookingGatewayPort();
      port.respondToSearchFlightsWith(ok([aFlightCandidate({ candidateId: "flight-1", destination: "TOKYO" })]));
      const priceCheck = new FakePriceCheckPort();
      priceCheck.respondToCheckPriceWith(err({ type: "NavigationFailed", message: "browser session timed out" }));
      const executor = new BookingToolExecutor(port, new FakeBudgetPort(), priceCheck);
      const sessionId = aRuntimeSessionId();

      await executor.execute({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }, sessionId);
      const result = await executor.execute(
        { toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } },
        sessionId,
      );

      expect(result).toEqual({ toolUseId: "call-2", isError: true, content: { error: "browser session timed out" } });
      expect(port.receivedHoldFlightCandidateIds).toEqual([]);
    });

    it("blocks a hold-hotel call when the price-check fails, without ever calling Gateway's hold-hotel", async () => {
      const port = new FakeBookingGatewayPort();
      port.respondToSearchHotelsWith(ok([aHotelCandidate({ candidateId: "hotel-1", city: "PARIS" })]));
      const priceCheck = new FakePriceCheckPort();
      priceCheck.respondToCheckPriceWith(err({ type: "MalformedPrice", message: "page returned non-JSON content" }));
      const executor = new BookingToolExecutor(port, new FakeBudgetPort(), priceCheck);
      const sessionId = aRuntimeSessionId();

      await executor.execute({ toolUseId: "call-1", name: "search-hotels", input: { city: "PARIS" } }, sessionId);
      const result = await executor.execute(
        { toolUseId: "call-2", name: "hold-hotel", input: { candidateId: "hotel-1" } },
        sessionId,
      );

      expect(result).toEqual({ toolUseId: "call-2", isError: true, content: { error: "page returned non-JSON content" } });
      expect(port.receivedHoldHotelCandidateIds).toEqual([]);
    });

    it("records a hold against a candidate searched in an earlier, separate call (a prior conversation turn)", async () => {
      // BookingToolExecutor is a long-lived singleton (composition-root.ts),
      // shared across every turn of a session — its candidate cache must
      // survive a search in one respondToCallerMessage call and a hold in a
      // later one, not just within a single execute() burst.
      const port = new FakeBookingGatewayPort();
      port.respondToSearchFlightsWith(ok([aFlightCandidate({ candidateId: "flight-1", destination: "TOKYO" })]));
      port.respondToHoldFlightWith(ok(aHold({ holdId: "hold-1" })));
      const priceCheck = new FakePriceCheckPort();
      priceCheck.respondToCheckPriceWith(ok(aLocalPrice()));
      const budget = new FakeBudgetPort();
      const snapshot = aBudgetSnapshot();
      budget.respondToRecordHoldWith(ok(snapshot));
      const executor = new BookingToolExecutor(port, budget, priceCheck);
      const sessionId = aRuntimeSessionId();

      await executor.execute(
        { toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } },
        sessionId,
      );
      // A later, independent call — as if a new respondToCallerMessage
      // invocation for the next Caller message.
      const result = await executor.execute(
        { toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } },
        sessionId,
      );

      expect(result.content).toMatchObject({ budget: snapshot.toJSON() });
    });

    it("holds successfully without a price-check or budget snapshot when the candidate was never searched in this executor", async () => {
      const port = new FakeBookingGatewayPort();
      port.respondToHoldFlightWith(ok(aHold({ holdId: "hold-1" })));
      const priceCheck = new FakePriceCheckPort();
      const budget = new FakeBudgetPort();
      const executor = new BookingToolExecutor(port, budget, priceCheck);

      const result = await executor.execute(
        { toolUseId: "call-1", name: "hold-flight", input: { candidateId: "flight-unknown" } },
        aRuntimeSessionId(),
      );

      expect(result).toEqual({
        toolUseId: "call-1",
        isError: false,
        content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
      });
      expect(priceCheck.receivedCheckPriceCalls).toEqual([]);
      expect(budget.receivedRecordHoldCalls).toEqual([]);
    });

    it("still returns a successful hold (at the Live price) when the Budget port fails", async () => {
      const port = new FakeBookingGatewayPort();
      port.respondToSearchFlightsWith(ok([aFlightCandidate({ candidateId: "flight-1" })]));
      port.respondToHoldFlightWith(ok(aHold({ holdId: "hold-1" })));
      const priceCheck = new FakePriceCheckPort();
      priceCheck.respondToCheckPriceWith(ok(aLocalPrice()));
      const budget = new FakeBudgetPort();
      budget.respondToRecordHoldWith(err({ type: "SandboxUnavailable", message: "session start timed out" }));
      const executor = new BookingToolExecutor(port, budget, priceCheck);
      const sessionId = aRuntimeSessionId();

      await executor.execute({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }, sessionId);
      const result = await executor.execute(
        { toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } },
        sessionId,
      );

      expect(result).toEqual({
        toolUseId: "call-2",
        isError: false,
        content: {
          holdId: "hold-1",
          status: "held",
          expiresAt: "2026-09-01T00:00:00.000Z",
          livePrice: aLocalPrice().toJSON(),
        },
      });
    });
  });
});

import type { BudgetSnapshot } from "../domain/budget-snapshot";
import type { FlightCandidate, FlightCandidateId } from "../domain/flight-candidate";
import type { GatewayError } from "../domain/gateway-error";
import type { Hold } from "../domain/hold";
import type { HotelCandidate, HotelCandidateId } from "../domain/hotel-candidate";
import type { LocalPrice } from "../domain/local-price";
import { parseNonBlankId } from "../domain/non-blank-id";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import { parseScenarioCity } from "../domain/scenario-city";
import type {
  BookingGatewayPort,
  BudgetPort,
  PriceCheckPort,
  ToolCall,
  ToolCallResult,
  ToolExecutor,
} from "./ports";
import { toolError, toolSuccess } from "./tool-call-result";

export const BOOKING_TOOL_NAMES = [
  "search-flights",
  "search-hotels",
  "hold-flight",
  "hold-hotel",
  "approve-hold",
] as const;
type BookingToolName = (typeof BOOKING_TOOL_NAMES)[number];

function isBookingToolName(name: string): name is BookingToolName {
  return (BOOKING_TOOL_NAMES as readonly string[]).includes(name);
}

function serializeFlightCandidate(candidate: FlightCandidate) {
  return {
    candidateId: candidate.candidateId,
    destination: candidate.destination,
    airline: candidate.airline,
    price: candidate.price.toJSON(),
  };
}

function serializeHotelCandidate(candidate: HotelCandidate) {
  return {
    candidateId: candidate.candidateId,
    city: candidate.city,
    hotelName: candidate.hotelName,
    price: candidate.price.toJSON(),
  };
}

function serializeHold(hold: Hold, livePrice?: LocalPrice, budget?: BudgetSnapshot) {
  return {
    holdId: hold.holdId,
    status: hold.status,
    expiresAt: hold.expiresAt.toISOString(),
    ...(livePrice ? { livePrice: livePrice.toJSON() } : {}),
    ...(budget ? { budget: budget.toJSON() } : {}),
  };
}

// Dispatches a model tool-use call to Gateway's booking target (issue #15),
// translating between the model's untyped tool arguments and the
// BookingGatewayPort's domain-typed methods. Also bridges search results
// into Browser Tool's price-check (issue #19 / ADR-0005) and Code
// Interpreter's budget/currency math (issue #18): Gateway's
// hold-flight/hold-hotel mock doesn't echo back the held item's price, so
// this executor remembers each candidate it showed the model during a
// search, keyed by candidateId, to recover the city/category a successful
// hold needs, and to run a price-check against — automatically, before
// every hold call, never left to agent discretion. The price-check's Live
// price (not the candidate's Quoted price) is what gets held, surfaced to
// the Caller, and recorded against the budget.
export class BookingToolExecutor implements ToolExecutor {
  private readonly flightCandidatesById = new Map<FlightCandidateId, FlightCandidate>();
  private readonly hotelCandidatesById = new Map<HotelCandidateId, HotelCandidate>();
  // Policy's approved-retry Cedar rule (ADR-0006, revised) is stateless —
  // it only sees whether *this* request carries `approved: true`. The
  // one-time-consumption guarantee that used to live in a Dogwood temporal
  // policy now lives here: a session enters this set when approve-hold
  // succeeds, and leaves it the moment a hold sent with that approval
  // succeeds, so a second, unrelated expensive hold is gated again.
  private readonly approvedSessions = new Set<RuntimeSessionId>();

  constructor(
    private readonly bookingGateway: BookingGatewayPort,
    private readonly budget: BudgetPort,
    private readonly priceCheck: PriceCheckPort,
  ) {}

  async execute(call: ToolCall, sessionId: RuntimeSessionId): Promise<ToolCallResult> {
    if (!isBookingToolName(call.name)) {
      return toolError(call.toolUseId, `unknown tool: ${call.name}`);
    }

    const input = (call.input ?? {}) as Record<string, unknown>;

    switch (call.name) {
      case "search-flights":
        return this.searchFlights(call.toolUseId, input, sessionId);
      case "search-hotels":
        return this.searchHotels(call.toolUseId, input, sessionId);
      case "hold-flight":
        return this.holdFlight(call.toolUseId, input, sessionId);
      case "hold-hotel":
        return this.holdHotel(call.toolUseId, input, sessionId);
      case "approve-hold":
        return this.approveHold(call.toolUseId, sessionId);
    }
  }

  private async searchFlights(
    toolUseId: string,
    input: Record<string, unknown>,
    sessionId: RuntimeSessionId,
  ): Promise<ToolCallResult> {
    const destination = parseScenarioCity(String(input.destination ?? ""));
    if (!destination.ok) {
      return toolError(toolUseId, destination.error.message);
    }

    const result = await this.bookingGateway.searchFlights(destination.value, sessionId);
    if (!result.ok) {
      return toolError(toolUseId, result.error.message);
    }
    for (const candidate of result.value) {
      this.flightCandidatesById.set(candidate.candidateId, candidate);
    }
    // Bedrock's Converse API requires toolResult.content[0].json to be a JSON
    // object, not a bare array — candidates must be nested under a key.
    return toolSuccess(toolUseId, { candidates: result.value.map(serializeFlightCandidate) });
  }

  private async searchHotels(
    toolUseId: string,
    input: Record<string, unknown>,
    sessionId: RuntimeSessionId,
  ): Promise<ToolCallResult> {
    const city = parseScenarioCity(String(input.city ?? ""));
    if (!city.ok) {
      return toolError(toolUseId, city.error.message);
    }

    const result = await this.bookingGateway.searchHotels(city.value, sessionId);
    if (!result.ok) {
      return toolError(toolUseId, result.error.message);
    }
    for (const candidate of result.value) {
      this.hotelCandidatesById.set(candidate.candidateId, candidate);
    }
    return toolSuccess(toolUseId, { candidates: result.value.map(serializeHotelCandidate) });
  }

  private async holdFlight(
    toolUseId: string,
    input: Record<string, unknown>,
    sessionId: RuntimeSessionId,
  ): Promise<ToolCallResult> {
    const candidateId = parseNonBlankId<"FlightCandidateId">("candidateId", String(input.candidateId ?? ""));
    if (!candidateId.ok) {
      return toolError(toolUseId, candidateId.error.message);
    }

    const approved = this.approvedSessions.has(sessionId);
    const candidate = this.flightCandidatesById.get(candidateId.value);
    if (!candidate) {
      const result = await this.bookingGateway.holdFlight(candidateId.value, undefined, approved, sessionId);
      if (!result.ok) {
        return holdErrorResult(toolUseId, result.error);
      }
      this.consumeApproval(approved, sessionId);
      return toolSuccess(toolUseId, serializeHold(result.value));
    }

    const livePrice = await this.priceCheck.checkPrice(candidateId.value, candidate.destination);
    if (!livePrice.ok) {
      return toolError(toolUseId, livePrice.error.message);
    }

    const result = await this.bookingGateway.holdFlight(candidateId.value, livePrice.value.amount, approved, sessionId);
    if (!result.ok) {
      return holdErrorResult(toolUseId, result.error, livePrice.value);
    }
    this.consumeApproval(approved, sessionId);
    const budget = await this.budget.recordHold(sessionId, candidate.destination, "FLIGHT", livePrice.value);
    return toolSuccess(toolUseId, serializeHold(result.value, livePrice.value, budget.ok ? budget.value : undefined));
  }

  private async holdHotel(
    toolUseId: string,
    input: Record<string, unknown>,
    sessionId: RuntimeSessionId,
  ): Promise<ToolCallResult> {
    const candidateId = parseNonBlankId<"HotelCandidateId">("candidateId", String(input.candidateId ?? ""));
    if (!candidateId.ok) {
      return toolError(toolUseId, candidateId.error.message);
    }

    const approved = this.approvedSessions.has(sessionId);
    const candidate = this.hotelCandidatesById.get(candidateId.value);
    if (!candidate) {
      const result = await this.bookingGateway.holdHotel(candidateId.value, undefined, approved, sessionId);
      if (!result.ok) {
        return holdErrorResult(toolUseId, result.error);
      }
      this.consumeApproval(approved, sessionId);
      return toolSuccess(toolUseId, serializeHold(result.value));
    }

    const livePrice = await this.priceCheck.checkPrice(candidateId.value, candidate.city);
    if (!livePrice.ok) {
      return toolError(toolUseId, livePrice.error.message);
    }

    const result = await this.bookingGateway.holdHotel(candidateId.value, livePrice.value.amount, approved, sessionId);
    if (!result.ok) {
      return holdErrorResult(toolUseId, result.error, livePrice.value);
    }
    this.consumeApproval(approved, sessionId);
    const budget = await this.budget.recordHold(sessionId, candidate.city, "HOTEL", livePrice.value);
    return toolSuccess(toolUseId, serializeHold(result.value, livePrice.value, budget.ok ? budget.value : undefined));
  }

  private async approveHold(toolUseId: string, sessionId: RuntimeSessionId): Promise<ToolCallResult> {
    const result = await this.bookingGateway.approveHold(sessionId);
    if (!result.ok) {
      return toolError(toolUseId, result.error.message);
    }
    this.approvedSessions.add(sessionId);
    return toolSuccess(toolUseId, { approved: true });
  }

  private consumeApproval(wasApproved: boolean, sessionId: RuntimeSessionId): void {
    if (wasApproved) {
      this.approvedSessions.delete(sessionId);
    }
  }
}

// A HoldGated denial (issue #20 / ADR-0006) isn't a broken call — it's the
// same "not authorized yet, here's what to do about it" shape as Identity's
// ConsentRequired (calendar-tool-executor.ts): the model needs the price to
// surface to the Caller and a signal to call approve-hold before retrying.
function holdErrorResult(toolUseId: string, error: GatewayError, livePrice?: LocalPrice): ToolCallResult {
  if (error.type !== "HoldGated") {
    return toolError(toolUseId, error.message);
  }
  if (!livePrice) {
    // No candidate was cached for this candidateId (never searched in this
    // executor instance), so there's no price to show the Caller — telling
    // the model to seek approval for an unstated amount would be worse than
    // telling it plainly that this candidate needs to be searched again.
    return toolError(
      toolUseId,
      "This hold could not be authorized and its price is unknown to this executor. Search for this candidate again, then retry the hold.",
      { gated: true },
    );
  }
  return toolError(
    toolUseId,
    "This hold's price requires the Caller's explicit approval before it can proceed. Ask the Caller to confirm, call approve-hold, then retry this hold.",
    { gated: true, price: livePrice.toJSON() },
  );
}

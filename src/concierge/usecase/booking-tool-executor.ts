import type { FlightCandidate } from "../domain/flight-candidate";
import type { Hold } from "../domain/hold";
import type { HotelCandidate } from "../domain/hotel-candidate";
import { parseNonBlankId } from "../domain/non-blank-id";
import { parseScenarioCity } from "../domain/scenario-city";
import type { BookingGatewayPort, ToolCall, ToolCallResult, ToolExecutor } from "./ports";

const BOOKING_TOOL_NAMES = ["search-flights", "search-hotels", "hold-flight", "hold-hotel"] as const;
type BookingToolName = (typeof BOOKING_TOOL_NAMES)[number];

function isBookingToolName(name: string): name is BookingToolName {
  return (BOOKING_TOOL_NAMES as readonly string[]).includes(name);
}

function toolError(toolUseId: string, message: string): ToolCallResult {
  return { toolUseId, isError: true, content: { error: message } };
}

function toolSuccess(toolUseId: string, content: unknown): ToolCallResult {
  return { toolUseId, isError: false, content };
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

function serializeHold(hold: Hold) {
  return { holdId: hold.holdId, status: hold.status, expiresAt: hold.expiresAt.toISOString() };
}

// Dispatches a model tool-use call to Gateway's booking target (issue #15),
// translating between the model's untyped tool arguments and the
// BookingGatewayPort's domain-typed methods.
export class BookingToolExecutor implements ToolExecutor {
  constructor(private readonly bookingGateway: BookingGatewayPort) {}

  async execute(call: ToolCall): Promise<ToolCallResult> {
    if (!isBookingToolName(call.name)) {
      return toolError(call.toolUseId, `unknown tool: ${call.name}`);
    }

    const input = (call.input ?? {}) as Record<string, unknown>;

    switch (call.name) {
      case "search-flights":
        return this.searchFlights(call.toolUseId, input);
      case "search-hotels":
        return this.searchHotels(call.toolUseId, input);
      case "hold-flight":
        return this.holdFlight(call.toolUseId, input);
      case "hold-hotel":
        return this.holdHotel(call.toolUseId, input);
    }
  }

  private async searchFlights(toolUseId: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    const destination = parseScenarioCity(String(input.destination ?? ""));
    if (!destination.ok) {
      return toolError(toolUseId, destination.error.message);
    }

    const result = await this.bookingGateway.searchFlights(destination.value);
    if (!result.ok) {
      return toolError(toolUseId, result.error.message);
    }
    return toolSuccess(toolUseId, result.value.map(serializeFlightCandidate));
  }

  private async searchHotels(toolUseId: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    const city = parseScenarioCity(String(input.city ?? ""));
    if (!city.ok) {
      return toolError(toolUseId, city.error.message);
    }

    const result = await this.bookingGateway.searchHotels(city.value);
    if (!result.ok) {
      return toolError(toolUseId, result.error.message);
    }
    return toolSuccess(toolUseId, result.value.map(serializeHotelCandidate));
  }

  private async holdFlight(toolUseId: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    const candidateId = parseNonBlankId<"FlightCandidateId">("candidateId", String(input.candidateId ?? ""));
    if (!candidateId.ok) {
      return toolError(toolUseId, candidateId.error.message);
    }

    const result = await this.bookingGateway.holdFlight(candidateId.value);
    if (!result.ok) {
      return toolError(toolUseId, result.error.message);
    }
    return toolSuccess(toolUseId, serializeHold(result.value));
  }

  private async holdHotel(toolUseId: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    const candidateId = parseNonBlankId<"HotelCandidateId">("candidateId", String(input.candidateId ?? ""));
    if (!candidateId.ok) {
      return toolError(toolUseId, candidateId.error.message);
    }

    const result = await this.bookingGateway.holdHotel(candidateId.value);
    if (!result.ok) {
      return toolError(toolUseId, result.error.message);
    }
    return toolSuccess(toolUseId, serializeHold(result.value));
  }
}

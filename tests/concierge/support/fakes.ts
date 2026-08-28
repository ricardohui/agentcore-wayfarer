import type { CallerMessage } from "../../../src/concierge/domain/caller-message";
import type { ConciergeReply } from "../../../src/concierge/domain/concierge-reply";
import type { ConversationTurn } from "../../../src/concierge/domain/conversation-turn";
import type { FlightCandidate, FlightCandidateId } from "../../../src/concierge/domain/flight-candidate";
import type { GatewayError } from "../../../src/concierge/domain/gateway-error";
import type { Hold } from "../../../src/concierge/domain/hold";
import type { HotelCandidate, HotelCandidateId } from "../../../src/concierge/domain/hotel-candidate";
import type { Result } from "../../../src/concierge/domain/result";
import type { ScenarioCity } from "../../../src/concierge/domain/scenario-city";
import type {
  BookingGatewayPort,
  ModelClient,
  ModelError,
  ToolCall,
  ToolCallResult,
  ToolExecutor,
} from "../../../src/concierge/usecase/ports";

export class FakeModelClient implements ModelClient {
  public receivedTranscripts: (readonly ConversationTurn[])[] = [];
  public receivedToolExecutors: ToolExecutor[] = [];
  private nextResult: Result<ConciergeReply, ModelError>;

  constructor(nextResult: Result<ConciergeReply, ModelError>) {
    this.nextResult = nextResult;
  }

  respondWith(result: Result<ConciergeReply, ModelError>): void {
    this.nextResult = result;
  }

  async generateReply(
    transcript: readonly ConversationTurn[],
    _message: CallerMessage,
    toolExecutor: ToolExecutor,
  ): Promise<Result<ConciergeReply, ModelError>> {
    this.receivedTranscripts.push(transcript);
    this.receivedToolExecutors.push(toolExecutor);
    return this.nextResult;
  }
}

export class FakeToolExecutor implements ToolExecutor {
  public receivedCalls: ToolCall[] = [];
  private resultsByToolUseId = new Map<string, ToolCallResult>();

  respondTo(toolUseId: string, result: Omit<ToolCallResult, "toolUseId">): void {
    this.resultsByToolUseId.set(toolUseId, { toolUseId, ...result });
  }

  async execute(call: ToolCall): Promise<ToolCallResult> {
    this.receivedCalls.push(call);
    const result = this.resultsByToolUseId.get(call.toolUseId);
    if (!result) {
      throw new Error(`FakeToolExecutor received unexpected toolUseId: ${call.toolUseId}`);
    }
    return result;
  }
}

export class FakeBookingGatewayPort implements BookingGatewayPort {
  public receivedSearchFlightsDestinations: ScenarioCity[] = [];
  public receivedSearchHotelsCities: ScenarioCity[] = [];
  public receivedHoldFlightCandidateIds: FlightCandidateId[] = [];
  public receivedHoldHotelCandidateIds: HotelCandidateId[] = [];

  private nextSearchFlights: Result<readonly FlightCandidate[], GatewayError> | undefined;
  private nextSearchHotels: Result<readonly HotelCandidate[], GatewayError> | undefined;
  private nextHoldFlight: Result<Hold, GatewayError> | undefined;
  private nextHoldHotel: Result<Hold, GatewayError> | undefined;

  respondToSearchFlightsWith(result: Result<readonly FlightCandidate[], GatewayError>): void {
    this.nextSearchFlights = result;
  }

  respondToSearchHotelsWith(result: Result<readonly HotelCandidate[], GatewayError>): void {
    this.nextSearchHotels = result;
  }

  respondToHoldFlightWith(result: Result<Hold, GatewayError>): void {
    this.nextHoldFlight = result;
  }

  respondToHoldHotelWith(result: Result<Hold, GatewayError>): void {
    this.nextHoldHotel = result;
  }

  async searchFlights(
    destination: ScenarioCity,
  ): Promise<Result<readonly FlightCandidate[], GatewayError>> {
    this.receivedSearchFlightsDestinations.push(destination);
    if (!this.nextSearchFlights) {
      throw new Error("FakeBookingGatewayPort.searchFlights called before respondToSearchFlightsWith");
    }
    return this.nextSearchFlights;
  }

  async searchHotels(city: ScenarioCity): Promise<Result<readonly HotelCandidate[], GatewayError>> {
    this.receivedSearchHotelsCities.push(city);
    if (!this.nextSearchHotels) {
      throw new Error("FakeBookingGatewayPort.searchHotels called before respondToSearchHotelsWith");
    }
    return this.nextSearchHotels;
  }

  async holdFlight(candidateId: FlightCandidateId): Promise<Result<Hold, GatewayError>> {
    this.receivedHoldFlightCandidateIds.push(candidateId);
    if (!this.nextHoldFlight) {
      throw new Error("FakeBookingGatewayPort.holdFlight called before respondToHoldFlightWith");
    }
    return this.nextHoldFlight;
  }

  async holdHotel(candidateId: HotelCandidateId): Promise<Result<Hold, GatewayError>> {
    this.receivedHoldHotelCandidateIds.push(candidateId);
    if (!this.nextHoldHotel) {
      throw new Error("FakeBookingGatewayPort.holdHotel called before respondToHoldHotelWith");
    }
    return this.nextHoldHotel;
  }
}

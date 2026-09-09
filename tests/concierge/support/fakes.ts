import type { ActorId } from "../../../src/concierge/domain/actor-id";
import type { BudgetCategory } from "../../../src/concierge/domain/budget-category";
import type { BudgetError } from "../../../src/concierge/domain/budget-error";
import type { BudgetSnapshot } from "../../../src/concierge/domain/budget-snapshot";
import type { CallerMessage } from "../../../src/concierge/domain/caller-message";
import type { CallerPreference } from "../../../src/concierge/domain/caller-preference";
import type { ConciergeReply } from "../../../src/concierge/domain/concierge-reply";
import type { ConversationTurn } from "../../../src/concierge/domain/conversation-turn";
import type { DestinationGuideExcerpt } from "../../../src/concierge/domain/destination-guide-excerpt";
import type { FlightCandidate, FlightCandidateId } from "../../../src/concierge/domain/flight-candidate";
import type { GatewayError } from "../../../src/concierge/domain/gateway-error";
import type { Hold } from "../../../src/concierge/domain/hold";
import type { HotelCandidate, HotelCandidateId } from "../../../src/concierge/domain/hotel-candidate";
import type { KnowledgeBaseError } from "../../../src/concierge/domain/knowledge-base-error";
import type { LocalPrice } from "../../../src/concierge/domain/local-price";
import type { MemoryError } from "../../../src/concierge/domain/memory-error";
import type { PriceCheckError } from "../../../src/concierge/domain/price-check-error";
import type { Result } from "../../../src/concierge/domain/result";
import type { RuntimeSessionId } from "../../../src/concierge/domain/runtime-session-id";
import type { ScenarioCity } from "../../../src/concierge/domain/scenario-city";
import type {
  BookingGatewayPort,
  BudgetPort,
  KnowledgeBasePort,
  MemoryPort,
  ModelClient,
  ModelError,
  PriceCheckPort,
  ToolCall,
  ToolCallResult,
  ToolExecutor,
} from "../../../src/concierge/usecase/ports";

export class FakeModelClient implements ModelClient {
  public receivedTranscripts: (readonly ConversationTurn[])[] = [];
  public receivedToolExecutors: ToolExecutor[] = [];
  public receivedPreferences: (readonly CallerPreference[])[] = [];
  public receivedSessionIds: RuntimeSessionId[] = [];
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
    preferences: readonly CallerPreference[],
    sessionId: RuntimeSessionId,
  ): Promise<Result<ConciergeReply, ModelError>> {
    this.receivedTranscripts.push(transcript);
    this.receivedToolExecutors.push(toolExecutor);
    this.receivedPreferences.push(preferences);
    this.receivedSessionIds.push(sessionId);
    return this.nextResult;
  }
}

export class FakeMemoryPort implements MemoryPort {
  public recordedTurns: { sessionId: RuntimeSessionId; actorId: ActorId; turn: ConversationTurn }[] = [];
  private readonly turnsByKey = new Map<string, ConversationTurn[]>();
  private readonly preferencesByActorId = new Map<ActorId, readonly CallerPreference[]>();
  private nextRecordResult: Result<void, MemoryError> = { ok: true, value: undefined };

  respondToRecordTurnWith(result: Result<void, MemoryError>): void {
    this.nextRecordResult = result;
  }

  givePreferences(actorId: ActorId, preferences: readonly CallerPreference[]): void {
    this.preferencesByActorId.set(actorId, preferences);
  }

  async recordTurn(
    sessionId: RuntimeSessionId,
    actorId: ActorId,
    turn: ConversationTurn,
  ): Promise<Result<void, MemoryError>> {
    this.recordedTurns.push({ sessionId, actorId, turn });
    if (this.nextRecordResult.ok) {
      const key = turnKey(sessionId, actorId);
      const turns = this.turnsByKey.get(key) ?? [];
      this.turnsByKey.set(key, [...turns, turn]);
    }
    return this.nextRecordResult;
  }

  async getRecentTurns(
    sessionId: RuntimeSessionId,
    actorId: ActorId,
    limit: number,
  ): Promise<Result<readonly ConversationTurn[], MemoryError>> {
    const turns = this.turnsByKey.get(turnKey(sessionId, actorId)) ?? [];
    return { ok: true, value: turns.slice(-limit) };
  }

  async getPreferences(actorId: ActorId): Promise<Result<readonly CallerPreference[], MemoryError>> {
    return { ok: true, value: this.preferencesByActorId.get(actorId) ?? [] };
  }
}

function turnKey(sessionId: RuntimeSessionId, actorId: ActorId): string {
  return `${sessionId} ${actorId}`;
}

export class FakeToolExecutor implements ToolExecutor {
  public receivedCalls: ToolCall[] = [];
  private resultsByToolUseId = new Map<string, ToolCallResult>();

  respondTo(toolUseId: string, result: Omit<ToolCallResult, "toolUseId">): void {
    this.resultsByToolUseId.set(toolUseId, { toolUseId, ...result });
  }

  async execute(call: ToolCall, _sessionId: RuntimeSessionId): Promise<ToolCallResult> {
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
  public receivedHoldFlightPrices: (number | undefined)[] = [];
  public receivedHoldFlightApprovedFlags: boolean[] = [];
  public receivedHoldHotelCandidateIds: HotelCandidateId[] = [];
  public receivedHoldHotelPrices: (number | undefined)[] = [];
  public receivedHoldHotelApprovedFlags: boolean[] = [];
  public receivedApproveHoldSessionIds: RuntimeSessionId[] = [];

  private nextSearchFlights: Result<readonly FlightCandidate[], GatewayError> | undefined;
  private nextSearchHotels: Result<readonly HotelCandidate[], GatewayError> | undefined;
  private nextHoldFlight: Result<Hold, GatewayError> | undefined;
  private nextHoldHotel: Result<Hold, GatewayError> | undefined;
  private nextApproveHold: Result<void, GatewayError> | undefined;

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

  respondToApproveHoldWith(result: Result<void, GatewayError>): void {
    this.nextApproveHold = result;
  }

  async searchFlights(
    destination: ScenarioCity,
    _sessionId: RuntimeSessionId,
  ): Promise<Result<readonly FlightCandidate[], GatewayError>> {
    this.receivedSearchFlightsDestinations.push(destination);
    if (!this.nextSearchFlights) {
      throw new Error("FakeBookingGatewayPort.searchFlights called before respondToSearchFlightsWith");
    }
    return this.nextSearchFlights;
  }

  async searchHotels(
    city: ScenarioCity,
    _sessionId: RuntimeSessionId,
  ): Promise<Result<readonly HotelCandidate[], GatewayError>> {
    this.receivedSearchHotelsCities.push(city);
    if (!this.nextSearchHotels) {
      throw new Error("FakeBookingGatewayPort.searchHotels called before respondToSearchHotelsWith");
    }
    return this.nextSearchHotels;
  }

  async holdFlight(
    candidateId: FlightCandidateId,
    price: number | undefined,
    approved: boolean,
    _sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>> {
    this.receivedHoldFlightCandidateIds.push(candidateId);
    this.receivedHoldFlightPrices.push(price);
    this.receivedHoldFlightApprovedFlags.push(approved);
    if (!this.nextHoldFlight) {
      throw new Error("FakeBookingGatewayPort.holdFlight called before respondToHoldFlightWith");
    }
    return this.nextHoldFlight;
  }

  async holdHotel(
    candidateId: HotelCandidateId,
    price: number | undefined,
    approved: boolean,
    _sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>> {
    this.receivedHoldHotelCandidateIds.push(candidateId);
    this.receivedHoldHotelPrices.push(price);
    this.receivedHoldHotelApprovedFlags.push(approved);
    if (!this.nextHoldHotel) {
      throw new Error("FakeBookingGatewayPort.holdHotel called before respondToHoldHotelWith");
    }
    return this.nextHoldHotel;
  }

  async approveHold(sessionId: RuntimeSessionId): Promise<Result<void, GatewayError>> {
    this.receivedApproveHoldSessionIds.push(sessionId);
    if (!this.nextApproveHold) {
      throw new Error("FakeBookingGatewayPort.approveHold called before respondToApproveHoldWith");
    }
    return this.nextApproveHold;
  }
}

export class FakeBudgetPort implements BudgetPort {
  public receivedRecordHoldCalls: {
    sessionId: RuntimeSessionId;
    city: ScenarioCity;
    category: BudgetCategory;
    price: LocalPrice;
  }[] = [];
  private nextResult: Result<BudgetSnapshot, BudgetError> | undefined;

  respondToRecordHoldWith(result: Result<BudgetSnapshot, BudgetError>): void {
    this.nextResult = result;
  }

  async recordHold(
    sessionId: RuntimeSessionId,
    city: ScenarioCity,
    category: BudgetCategory,
    price: LocalPrice,
  ): Promise<Result<BudgetSnapshot, BudgetError>> {
    this.receivedRecordHoldCalls.push({ sessionId, city, category, price });
    if (!this.nextResult) {
      throw new Error("FakeBudgetPort.recordHold called before respondToRecordHoldWith");
    }
    return this.nextResult;
  }
}

export class FakeKnowledgeBasePort implements KnowledgeBasePort {
  public receivedQueries: string[] = [];
  private nextResult: Result<readonly DestinationGuideExcerpt[], KnowledgeBaseError> | undefined;

  respondToRetrieveWith(result: Result<readonly DestinationGuideExcerpt[], KnowledgeBaseError>): void {
    this.nextResult = result;
  }

  async retrieve(query: string): Promise<Result<readonly DestinationGuideExcerpt[], KnowledgeBaseError>> {
    this.receivedQueries.push(query);
    if (!this.nextResult) {
      throw new Error("FakeKnowledgeBasePort.retrieve called before respondToRetrieveWith");
    }
    return this.nextResult;
  }
}

export class FakePriceCheckPort implements PriceCheckPort {
  public receivedCheckPriceCalls: { candidateId: FlightCandidateId | HotelCandidateId; city: ScenarioCity }[] = [];
  private nextResult: Result<LocalPrice, PriceCheckError> | undefined;

  respondToCheckPriceWith(result: Result<LocalPrice, PriceCheckError>): void {
    this.nextResult = result;
  }

  async checkPrice(
    candidateId: FlightCandidateId | HotelCandidateId,
    city: ScenarioCity,
  ): Promise<Result<LocalPrice, PriceCheckError>> {
    this.receivedCheckPriceCalls.push({ candidateId, city });
    if (!this.nextResult) {
      throw new Error("FakePriceCheckPort.checkPrice called before respondToCheckPriceWith");
    }
    return this.nextResult;
  }
}

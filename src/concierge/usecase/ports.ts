import type { ActorId } from "../domain/actor-id";
import type { CallerMessage } from "../domain/caller-message";
import type { CallerPreference } from "../domain/caller-preference";
import type { ConciergeReply } from "../domain/concierge-reply";
import type { ConversationTurn } from "../domain/conversation-turn";
import type { FlightCandidate, FlightCandidateId } from "../domain/flight-candidate";
import type { GatewayError } from "../domain/gateway-error";
import type { Hold } from "../domain/hold";
import type { HotelCandidate, HotelCandidateId } from "../domain/hotel-candidate";
import type { MemoryError } from "../domain/memory-error";
import type { Result } from "../domain/result";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { ScenarioCity } from "../domain/scenario-city";

export type ModelError =
  | { readonly type: "ModelUnavailable"; readonly message: string }
  | { readonly type: "InvalidResponse"; readonly message: string };

// One tool-use round trip: the model asks to call `name` with `input`, the
// Concierge dispatches it (via ToolExecutor) and feeds the result back.
export type ToolCall = { readonly toolUseId: string; readonly name: string; readonly input: unknown };

export type ToolCallResult = {
  readonly toolUseId: string;
  readonly content: unknown;
  readonly isError: boolean;
};

export interface ToolExecutor {
  execute(call: ToolCall): Promise<ToolCallResult>;
}

export interface ModelClient {
  generateReply(
    transcript: readonly ConversationTurn[],
    message: CallerMessage,
    toolExecutor: ToolExecutor,
    preferences: readonly CallerPreference[],
  ): Promise<Result<ConciergeReply, ModelError>>;
}

// Gateway's booking target (issue #15): search-flights, search-hotels,
// hold-flight, hold-hotel — the Concierge's usecase-owned port, backed by a
// real adapter that speaks MCP to AgentCore Gateway.
export interface BookingGatewayPort {
  searchFlights(destination: ScenarioCity): Promise<Result<readonly FlightCandidate[], GatewayError>>;
  searchHotels(city: ScenarioCity): Promise<Result<readonly HotelCandidate[], GatewayError>>;
  holdFlight(candidateId: FlightCandidateId): Promise<Result<Hold, GatewayError>>;
  holdHotel(candidateId: HotelCandidateId): Promise<Result<Hold, GatewayError>>;
}

// Memory (issue #16): create_event/get_last_k_turns back scratch state
// (session-scoped — a fresh runtimeSessionId sees no prior turns) and the
// user-preference/semantic Strategies extract long-term facts from those
// same events, recalled here by actorId across all of that actor's sessions.
export interface MemoryPort {
  recordTurn(
    sessionId: RuntimeSessionId,
    actorId: ActorId,
    turn: ConversationTurn,
  ): Promise<Result<void, MemoryError>>;
  getRecentTurns(
    sessionId: RuntimeSessionId,
    actorId: ActorId,
    limit: number,
  ): Promise<Result<readonly ConversationTurn[], MemoryError>>;
  getPreferences(actorId: ActorId): Promise<Result<readonly CallerPreference[], MemoryError>>;
}

export interface SessionLock {
  // Serializes read-modify-write access to one session's conversation, so two
  // overlapping invocations for the same runtimeSessionId can't race and drop
  // a turn (Runtime routes same-session calls to one microVM, but that VM's
  // event loop can still interleave two concurrent requests).
  runExclusive<TResult>(sessionId: RuntimeSessionId, fn: () => Promise<TResult>): Promise<TResult>;
}

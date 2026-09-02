import type { ActorId } from "../domain/actor-id";
import type { AuthenticationError } from "../domain/authentication-error";
import type { CalendarEvent } from "../domain/calendar-event";
import type { CallerMessage } from "../domain/caller-message";
import type { CallerPreference } from "../domain/caller-preference";
import type { ConciergeReply } from "../domain/concierge-reply";
import type { ConversationTurn } from "../domain/conversation-turn";
import type { DelegatedCredentialError } from "../domain/delegated-credential-error";
import type { FlightCandidate, FlightCandidateId } from "../domain/flight-candidate";
import type { GatewayError } from "../domain/gateway-error";
import type { Hold, HoldId } from "../domain/hold";
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

// Inbound auth (issue #17): verifies the raw Authorization header on every
// invocation and resolves the Caller's Cognito `sub` as ActorId. Called
// directly from infra/handler.ts, ahead of respondToCallerMessage — an
// unauthenticated or invalid-JWT request never reaches the usecase.
export interface JwtVerifierPort {
  verify(authorizationHeader: string | undefined): Promise<Result<ActorId, AuthenticationError>>;
}

// Identity's Delegated credential (issue #17 / ADR-0003): writes a calendar
// event confirming a held booking. The real adapter fetches a Delegated
// credential from AgentCore Identity's token vault for the current request's
// workload identity — no consent yet on file surfaces as ConsentRequired,
// carrying the authorizationUrl to show the Caller.
export interface CalendarPort {
  writeEvent(holdId: HoldId, title: string): Promise<Result<CalendarEvent, DelegatedCredentialError>>;
}

export interface SessionLock {
  // Serializes read-modify-write access to one session's conversation, so two
  // overlapping invocations for the same runtimeSessionId can't race and drop
  // a turn (Runtime routes same-session calls to one microVM, but that VM's
  // event loop can still interleave two concurrent requests).
  runExclusive<TResult>(sessionId: RuntimeSessionId, fn: () => Promise<TResult>): Promise<TResult>;
}

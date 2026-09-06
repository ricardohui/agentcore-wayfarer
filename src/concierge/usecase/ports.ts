import type { ActorId } from "../domain/actor-id";
import type { AuthenticationError } from "../domain/authentication-error";
import type { BudgetCategory } from "../domain/budget-category";
import type { BudgetError } from "../domain/budget-error";
import type { BudgetSnapshot } from "../domain/budget-snapshot";
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
import type { LocalPrice } from "../domain/local-price";
import type { MemoryError } from "../domain/memory-error";
import type { PriceCheckError } from "../domain/price-check-error";
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
  // sessionId (not carried on ToolCall itself, which mirrors the model's
  // untyped tool-use block) lets a session-scoped concern — Code
  // Interpreter's per-conversation budget sandbox (issue #18) — key its own
  // state without every ToolExecutor needing to be rebuilt per call.
  execute(call: ToolCall, sessionId: RuntimeSessionId): Promise<ToolCallResult>;
}

export interface ModelClient {
  generateReply(
    transcript: readonly ConversationTurn[],
    message: CallerMessage,
    toolExecutor: ToolExecutor,
    preferences: readonly CallerPreference[],
    sessionId: RuntimeSessionId,
  ): Promise<Result<ConciergeReply, ModelError>>;
}

// Gateway's booking target (issue #15, extended by issue #20 / ADR-0006):
// search-flights, search-hotels, hold-flight, hold-hotel, approve-hold — the
// Concierge's usecase-owned port, backed by a real adapter that speaks MCP
// to AgentCore Gateway. hold-flight/hold-hotel carry the candidate's price
// (undefined when no candidate was cached to price) so Policy's Cedar
// threshold can evaluate context.input.price at the Gateway boundary; the
// sessionId on hold-flight/hold-hotel/approve-hold becomes the Policy
// session header, correlating a Caller's approve-hold event with their own
// later hold attempt. A denied Gated hold surfaces as GatewayError's
// HoldGated variant, not a thrown exception.
export interface BookingGatewayPort {
  searchFlights(destination: ScenarioCity): Promise<Result<readonly FlightCandidate[], GatewayError>>;
  searchHotels(city: ScenarioCity): Promise<Result<readonly HotelCandidate[], GatewayError>>;
  holdFlight(
    candidateId: FlightCandidateId,
    price: number | undefined,
    sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>>;
  holdHotel(
    candidateId: HotelCandidateId,
    price: number | undefined,
    sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>>;
  approveHold(sessionId: RuntimeSessionId): Promise<Result<void, GatewayError>>;
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

// Code Interpreter's budget/currency math (issue #18 / ADR-0004): converts a
// held item's Local price to Home currency (USD) via a static mock rate
// table executed in a sandboxed Code Interpreter session, and folds it into
// the trip's Running total and Budget breakdown (CONTEXT.md). One sandbox
// session persists per RuntimeSessionId — the real adapter reuses it across
// every hold in the same planning conversation (clearContext: false), which
// is what makes the Running total accumulate as the sandbox's own state
// rather than something this port's caller has to track itself.
export interface BudgetPort {
  recordHold(
    sessionId: RuntimeSessionId,
    city: ScenarioCity,
    category: BudgetCategory,
    price: LocalPrice,
  ): Promise<Result<BudgetSnapshot, BudgetError>>;
}

// Browser Tool's price-check (issue #19 / ADR-0005): a one-shot Browser
// session (navigate, read price, close) run automatically immediately
// before every hold-flight/hold-hotel call, for every candidate — never
// agent discretion. The mock price-check site randomizes its price
// independently of Gateway's mock catalog, so the Live price this returns
// can diverge from the candidate's Quoted price; the Live price (not
// Quoted) is what gets held, shown to the Caller, and fed into BudgetPort.
export interface PriceCheckPort {
  checkPrice(
    candidateId: FlightCandidateId | HotelCandidateId,
    city: ScenarioCity,
  ): Promise<Result<LocalPrice, PriceCheckError>>;
}

export interface SessionLock {
  // Serializes read-modify-write access to one session's conversation, so two
  // overlapping invocations for the same runtimeSessionId can't race and drop
  // a turn (Runtime routes same-session calls to one microVM, but that VM's
  // event loop can still interleave two concurrent requests).
  runExclusive<TResult>(sessionId: RuntimeSessionId, fn: () => Promise<TResult>): Promise<TResult>;
}

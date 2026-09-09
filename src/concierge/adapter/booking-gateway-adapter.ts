import type { Span } from "@opentelemetry/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BOOKING_GATEWAY_TARGET_NAME } from "../../booking-gateway/gateway-target-name";
import { FlightCandidate, type FlightCandidateId } from "../domain/flight-candidate";
import type { GatewayError } from "../domain/gateway-error";
import { Hold } from "../domain/hold";
import { HotelCandidate, type HotelCandidateId } from "../domain/hotel-candidate";
import { err, ok, type Result } from "../domain/result";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { ScenarioCity } from "../domain/scenario-city";
import type { ValidationError } from "../domain/validation-error";
import type { BookingGatewayPort } from "../usecase/ports";
import { withSpan } from "../observability/tracing";
import type { FetchLike } from "./sigv4-fetch";

const CLIENT_INFO = { name: "wayfarer-concierge", version: "1.0.0" };

// Policy's own wording for a denied tool call (see "Use an AgentCore
// Gateway with Policy in AgentCore") — distinguishes a Gated hold from a
// genuine Gateway failure so the two surface as different GatewayError
// variants. Two independent markers, either sufficient, hedges against one
// of AWS's own wording changing underneath this substring match.
const POLICY_DENIAL_MARKERS = ["AuthorizeActionException", "policy enforcement"];

function isPolicyDenial(message: string): boolean {
  return POLICY_DENIAL_MARKERS.some((marker) => message.includes(marker));
}

// Shared by callTool's two failure paths (an isError:true response and a
// thrown McpError) — both carry the same policy-enforcement wording, so
// both classify into the same GatewayError variant the same way.
function toGatewayErrorResult(message: string, span: Span): Result<never, GatewayError> {
  const gatewayError: GatewayError = isPolicyDenial(message)
    ? { type: "HoldGated", message }
    : { type: "GatewayUnavailable", message };
  span.setAttribute("gen_ai.tool.call.result", JSON.stringify(gatewayError));
  return err(gatewayError);
}

// Speaks MCP to AgentCore Gateway's booking target (issue #15) over the given
// SigV4-signed fetch. Opens one MCP session per call — this ticket's scenario
// beat is search-then-hold, not a chatty tool-call sequence, so session reuse
// isn't worth the added lifecycle state yet.
//
// Every public method still accepts sessionId (BookingGatewayPort's shape —
// BookingToolExecutor uses it for its own approvedSessions bookkeeping) but
// none of them forward it to Gateway. Confirmed live (issue #20 revision):
// the Policy session header this adapter used to send made every single
// Gateway action fail with a generic "An internal error occurred", entirely
// independent of the Policy engine's policy content — reproduced with a
// Dogwood temporal policy attached, and again after removing every temporal
// policy and leaving only stateless Cedar. Dropping the header (confirmed
// via a direct probe against the live Gateway with no header at all) is
// what actually fixed it — not the stateless-Cedar redesign itself, which
// only removed a rule this header was never required for.
export class BookingGatewayAdapter implements BookingGatewayPort {
  constructor(
    private readonly gatewayUrl: string,
    private readonly fetch: FetchLike,
  ) {}

  async searchFlights(
    destination: ScenarioCity,
    sessionId: RuntimeSessionId,
  ): Promise<Result<readonly FlightCandidate[], GatewayError>> {
    const result = await this.callTool("search-flights", { destination }, sessionId);
    if (!result.ok) {
      return result;
    }
    return parseCandidateList(result.value, (item) => FlightCandidate.parse(item));
  }

  async searchHotels(
    city: ScenarioCity,
    sessionId: RuntimeSessionId,
  ): Promise<Result<readonly HotelCandidate[], GatewayError>> {
    const result = await this.callTool("search-hotels", { city }, sessionId);
    if (!result.ok) {
      return result;
    }
    return parseCandidateList(result.value, (item) => HotelCandidate.parse(item));
  }

  async holdFlight(
    candidateId: FlightCandidateId,
    price: number | undefined,
    approved: boolean,
    sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>> {
    const result = await this.callTool("hold-flight", holdArguments(candidateId, price, approved), sessionId);
    if (!result.ok) {
      return result;
    }
    return toGatewayResult(Hold.parse(result.value));
  }

  async holdHotel(
    candidateId: HotelCandidateId,
    price: number | undefined,
    approved: boolean,
    sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>> {
    const result = await this.callTool("hold-hotel", holdArguments(candidateId, price, approved), sessionId);
    if (!result.ok) {
      return result;
    }
    return toGatewayResult(Hold.parse(result.value));
  }

  async approveHold(sessionId: RuntimeSessionId): Promise<Result<void, GatewayError>> {
    const result = await this.callTool("approve-hold", {}, sessionId);
    if (!result.ok) {
      return result;
    }
    return ok(undefined);
  }

  // Gateway span (issue #24 / ADR-0008): one execute_tool span per booking
  // action, covering both Gateway's own call and Policy's Cedar gate on it —
  // a HoldGated result is visible right here as this span's own
  // gen_ai.tool.call.result, not a separate Policy span, since Policy's
  // ALLOW/DENY decision has no AWS call of its own on this side of the wire.
  private async callTool(
    operation: string,
    args: Record<string, unknown>,
    sessionId: RuntimeSessionId,
  ): Promise<Result<unknown, GatewayError>> {
    return withSpan(
      `execute_tool ${operation}`,
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": operation,
        "gen_ai.tool.call.arguments": JSON.stringify(args),
        "session.id": sessionId,
      },
      async (span) => {
        const client = new Client(CLIENT_INFO);
        const transport = new StreamableHTTPClientTransport(new URL(this.gatewayUrl), {
          // FetchLike is pinned to undici's own Request/Response types (see
          // sigv4-fetch.ts); the MCP SDK's own FetchLike declares itself against
          // the ambient global fetch types instead — structurally the same
          // function at runtime, just an upstream typing mismatch.
          fetch: this.fetch as unknown as typeof fetch,
        });

        try {
          // The SDK's own StreamableHTTPClientTransport doesn't satisfy Transport
          // under exactOptionalPropertyTypes (its sessionId getter returns
          // `string | undefined` against an optional `sessionId?: string`) — an
          // upstream typing gap, not a runtime concern.
          await client.connect(transport as unknown as Transport);
          const response = await client.callTool({
            name: `${BOOKING_GATEWAY_TARGET_NAME}___${operation}`,
            arguments: args,
          });

          if (response.isError) {
            return toGatewayErrorResult(extractText(response.content), span);
          }
          const value = extractJson(response.content);
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(value));
          return ok(value);
        } catch (error) {
          // Confirmed live against the deployed Gateway (issue #20): a Policy
          // denial arrives as a genuine JSON-RPC-level error — the MCP SDK
          // throws an McpError for it — not as a normal result with
          // isError:true. Both shapes carry the same policy-enforcement wording,
          // so the same isPolicyDenial check applies here too.
          return toGatewayErrorResult(error instanceof Error ? error.message : String(error), span);
        } finally {
          // A close() failure must never override the try/catch's Result — it
          // would otherwise reject the whole call (discarding a sibling tool
          // call's already-successful result when both run under Promise.all).
          await client.close().catch(() => undefined);
        }
      },
    );
  }
}

// `price`/`approved` are omitted rather than sent as `undefined`/`false`
// when they don't apply — matches tool-catalog.ts's "optional, model must
// not set" schema for both fields, and keeps the wire payload matching what
// Policy's Cedar `has` presence guards expect on a plain (non-Gated) hold.
function holdArguments(
  candidateId: string,
  price: number | undefined,
  approved: boolean,
): Record<string, unknown> {
  return {
    candidateId,
    ...(price !== undefined ? { price } : {}),
    ...(approved ? { approved: true } : {}),
  };
}

type TextContentBlock = { readonly type: "text"; readonly text: string };

function isTextBlock(block: unknown): block is TextContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function extractText(content: unknown): string {
  const block = Array.isArray(content) ? content.find(isTextBlock) : undefined;
  return block?.text ?? "Gateway returned no error detail";
}

function extractJson(content: unknown): unknown {
  const block = Array.isArray(content) ? content.find(isTextBlock) : undefined;
  if (!block) {
    return content;
  }
  try {
    return JSON.parse(block.text);
  } catch {
    return block.text;
  }
}

function parseCandidateList<TCandidate>(
  raw: unknown,
  parse: (item: unknown) => Result<TCandidate, ValidationError>,
): Result<readonly TCandidate[], GatewayError> {
  if (!Array.isArray(raw)) {
    return err({ type: "MalformedResponse", message: "expected an array of candidates" });
  }

  const candidates: TCandidate[] = [];
  for (const item of raw) {
    const result = parse(item);
    if (!result.ok) {
      return err({ type: "MalformedResponse", message: result.error.message });
    }
    candidates.push(result.value);
  }
  return ok(candidates);
}

function toGatewayResult<TValue>(result: Result<TValue, ValidationError>): Result<TValue, GatewayError> {
  if (!result.ok) {
    return err({ type: "MalformedResponse", message: result.error.message });
  }
  return result;
}

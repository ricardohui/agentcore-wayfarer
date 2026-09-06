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
import type { FetchLike } from "./sigv4-fetch";

const CLIENT_INFO = { name: "wayfarer-concierge", version: "1.0.0" };

// Session-based temporal policies (issue #20 / ADR-0006) evaluate a Cedar
// trajectory scoped to whatever session ID a request carries under this
// header — passing the Concierge's own RuntimeSessionId here is what lets
// Policy's one-time-consumption rule correlate a Caller's approve-hold
// event with their own later hold-flight/hold-hotel retry.
const POLICY_SESSION_HEADER = "x-amzn-bedrock-agentcore-policy-session-id";

// Policy's own wording for a denied tool call (see "Use an AgentCore
// Gateway with Policy in AgentCore") — distinguishes a Gated hold from a
// genuine Gateway failure so the two surface as different GatewayError
// variants. Two independent markers, either sufficient, hedges against one
// of AWS's own wording changing underneath this substring match.
const POLICY_DENIAL_MARKERS = ["AuthorizeActionException", "policy enforcement"];

function isPolicyDenial(message: string): boolean {
  return POLICY_DENIAL_MARKERS.some((marker) => message.includes(marker));
}

// Speaks MCP to AgentCore Gateway's booking target (issue #15) over the given
// SigV4-signed fetch. Opens one MCP session per call — this ticket's scenario
// beat is search-then-hold, not a chatty tool-call sequence, so session reuse
// isn't worth the added lifecycle state yet.
export class BookingGatewayAdapter implements BookingGatewayPort {
  constructor(
    private readonly gatewayUrl: string,
    private readonly fetch: FetchLike,
  ) {}

  async searchFlights(destination: ScenarioCity): Promise<Result<readonly FlightCandidate[], GatewayError>> {
    const result = await this.callTool("search-flights", { destination });
    if (!result.ok) {
      return result;
    }
    return parseCandidateList(result.value, (item) => FlightCandidate.parse(item));
  }

  async searchHotels(city: ScenarioCity): Promise<Result<readonly HotelCandidate[], GatewayError>> {
    const result = await this.callTool("search-hotels", { city });
    if (!result.ok) {
      return result;
    }
    return parseCandidateList(result.value, (item) => HotelCandidate.parse(item));
  }

  async holdFlight(
    candidateId: FlightCandidateId,
    price: number | undefined,
    sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>> {
    const result = await this.callTool(
      "hold-flight",
      price !== undefined ? { candidateId, price } : { candidateId },
      sessionId,
    );
    if (!result.ok) {
      return result;
    }
    return toGatewayResult(Hold.parse(result.value));
  }

  async holdHotel(
    candidateId: HotelCandidateId,
    price: number | undefined,
    sessionId: RuntimeSessionId,
  ): Promise<Result<Hold, GatewayError>> {
    const result = await this.callTool(
      "hold-hotel",
      price !== undefined ? { candidateId, price } : { candidateId },
      sessionId,
    );
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

  private async callTool(
    operation: string,
    args: Record<string, unknown>,
    policySessionId?: RuntimeSessionId,
  ): Promise<Result<unknown, GatewayError>> {
    const client = new Client(CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(new URL(this.gatewayUrl), {
      // FetchLike is pinned to undici's own Request/Response types (see
      // sigv4-fetch.ts); the MCP SDK's own FetchLike declares itself against
      // the ambient global fetch types instead — structurally the same
      // function at runtime, just an upstream typing mismatch.
      fetch: this.fetch as unknown as typeof fetch,
      ...(policySessionId
        ? { requestInit: { headers: { [POLICY_SESSION_HEADER]: policySessionId } } }
        : {}),
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
        const message = extractText(response.content);
        if (isPolicyDenial(message)) {
          return err({ type: "HoldGated", message });
        }
        return err({ type: "GatewayUnavailable", message });
      }
      return ok(extractJson(response.content));
    } catch (error) {
      return err({
        type: "GatewayUnavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // A close() failure must never override the try/catch's Result — it
      // would otherwise reject the whole call (discarding a sibling tool
      // call's already-successful result when both run under Promise.all).
      await client.close().catch(() => undefined);
    }
  }
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

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { MockAgent } from "undici";

export const GATEWAY_URL = "https://test-gateway.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";

const POLICY_SESSION_HEADER = "x-amzn-bedrock-agentcore-policy-session-id";

type JsonRpcRequestBody = {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly arguments?: unknown };
};

export type MockToolResponse =
  | { readonly content: unknown; readonly isError?: boolean }
  // The real Gateway (confirmed live, issue #20) surfaces a Policy denial as
  // a genuine JSON-RPC-level error, not a normal result with isError:true —
  // the MCP SDK throws an McpError for this, a different code path than the
  // isError:true shape below.
  | { readonly protocolError: { readonly code: number; readonly message: string } };

export type ReceivedToolCall = {
  readonly name: string;
  readonly arguments: unknown;
  readonly policySessionHeader?: string;
};

// Registers onto the shared NetworkBoundary's MockAgent, intercepting the
// actual SigV4-signed fetch calls BookingGatewayAdapter's MCP transport
// makes — standing in for AgentCore Gateway (which itself would forward
// tools/call to the mock Lambda router, or, for hold-flight/hold-hotel/
// approve-hold, to Policy's ENFORCE-mode decision first, issue #20 /
// ADR-0006).
export class GatewayMockServer {
  public readonly receivedToolCalls: ReceivedToolCall[] = [];
  private readonly responseQueuesByToolName = new Map<string, MockToolResponse[]>();

  constructor(agent: MockAgent) {
    const url = new URL(GATEWAY_URL);
    agent
      .get(url.origin)
      .intercept({ path: url.pathname, method: "POST" })
      .reply(200, (opts) => this.handle(String(opts.body ?? ""), opts.headers), {
        headers: { "content-type": "application/json" },
      })
      .persist();
  }

  // Each call queues one response; once only one remains queued, it repeats
  // for every further call to the same tool (matching this method's
  // original single-response-forever behavior when called just once).
  respondToTool(toolName: string, response: MockToolResponse): void {
    const queue = this.responseQueuesByToolName.get(toolName) ?? [];
    queue.push(response);
    this.responseQueuesByToolName.set(toolName, queue);
  }

  private handle(rawBody: string, headers: unknown): Record<string, unknown> {
    const body = JSON.parse(rawBody) as JsonRpcRequestBody;

    switch (body.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "mock-booking-gateway", version: "1.0.0" },
          },
        };
      case "notifications/initialized":
        return {};
      case "tools/call":
        return this.handleToolCall(body, headers);
      default:
        throw new Error(`GatewayMockServer received unexpected method: ${body.method}`);
    }
  }

  private handleToolCall(body: JsonRpcRequestBody, headers: unknown): Record<string, unknown> {
    const fullName = body.params?.name ?? "";
    const shortName = fullName.includes("___") ? fullName.split("___")[1] : fullName;
    const queue = shortName ? this.responseQueuesByToolName.get(shortName) : undefined;
    if (!queue || queue.length === 0) {
      throw new Error(`GatewayMockServer received unexpected tool call: ${fullName}`);
    }
    const response = queue.length > 1 ? queue.shift()! : queue[0]!;

    if (shortName) {
      const policySessionHeader = extractHeader(headers, POLICY_SESSION_HEADER);
      this.receivedToolCalls.push({
        name: shortName,
        arguments: body.params?.arguments,
        ...(policySessionHeader !== undefined ? { policySessionHeader } : {}),
      });
    }

    if ("protocolError" in response) {
      return { jsonrpc: "2.0", id: body.id, error: response.protocolError };
    }

    const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    return {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text }],
        isError: response.isError ?? false,
      },
    };
  }
}

function extractHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const value = (headers as Record<string, string | readonly string[]>)[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

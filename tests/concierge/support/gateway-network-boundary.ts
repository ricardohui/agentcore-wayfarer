import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";

export const GATEWAY_URL = "https://test-gateway.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";

type JsonRpcRequestBody = {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly arguments?: unknown };
};

export type MockToolResponse = { readonly content: unknown; readonly isError?: boolean };

// The shared network-boundary harness for every test exercising the real
// BookingGatewayAdapter: a real undici MockAgent intercepting the actual
// SigV4-signed fetch calls the adapter's MCP transport makes, standing in
// for AgentCore Gateway (which itself would forward tools/call to the mock
// Lambda router).
export class GatewayMockServer {
  private readonly agent = new MockAgent();
  private readonly previousDispatcher: Dispatcher;
  private readonly responsesByToolName = new Map<string, MockToolResponse>();

  constructor() {
    this.previousDispatcher = getGlobalDispatcher();
    // Deliberately leave net connect enabled: only the gateway origin below
    // is intercepted, so the acceptance harness's own calls to the local
    // Concierge server still hit the real network.
    setGlobalDispatcher(this.agent);

    const url = new URL(GATEWAY_URL);
    this.agent
      .get(url.origin)
      .intercept({ path: url.pathname, method: "POST" })
      .reply(200, (opts) => this.handle(String(opts.body ?? "")), {
        headers: { "content-type": "application/json" },
      })
      .persist();
  }

  respondToTool(toolName: string, response: MockToolResponse): void {
    this.responsesByToolName.set(toolName, response);
  }

  async close(): Promise<void> {
    await this.agent.close();
    setGlobalDispatcher(this.previousDispatcher);
  }

  private handle(rawBody: string): Record<string, unknown> {
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
        return this.handleToolCall(body);
      default:
        throw new Error(`GatewayMockServer received unexpected method: ${body.method}`);
    }
  }

  private handleToolCall(body: JsonRpcRequestBody): Record<string, unknown> {
    const fullName = body.params?.name ?? "";
    const shortName = fullName.includes("___") ? fullName.split("___")[1] : fullName;
    const response = shortName ? this.responsesByToolName.get(shortName) : undefined;
    if (!response) {
      throw new Error(`GatewayMockServer received unexpected tool call: ${fullName}`);
    }

    return {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(response.content) }],
        isError: response.isError ?? false,
      },
    };
  }
}

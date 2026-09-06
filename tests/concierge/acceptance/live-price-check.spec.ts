import {
  CreateEventCommand,
  InvokeCodeInterpreterCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
  StartCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { codeInterpreterStream } from "../support/code-interpreter-stream";
import { CognitoMockServer } from "../support/cognito-network-boundary";
import { aSessionId, closeConciergeApp, invoke, waitForHealthy } from "../support/concierge-test-server";
import { GatewayMockServer } from "../support/gateway-network-boundary";
import { memoryMock } from "../support/memory-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

const navigateMock = vi.fn();
const getTextMock = vi.fn();
const stopSessionMock = vi.fn();

// Browser Tool's price-check (issue #19 / ADR-0005) has no HTTP/AWS-SDK
// network boundary to intercept for its actual page read (a real CDP
// session over a signed WebSocket) — same rationale as
// tests/concierge/adapter/browser-tool-price-check-adapter.spec.ts, this
// mocks bedrock-agentcore's Browser Tool client module itself.
vi.mock("bedrock-agentcore/browser/playwright", () => ({
  PlaywrightBrowser: vi.fn().mockImplementation(() => ({
    navigate: navigateMock,
    getText: getTextMock,
    stopSession: stopSessionMock,
  })),
}));

const PORT = 41828;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Issue #19 / ADR-0005: a candidate whose Live price (read from the mock
// price-check site) differs from its Quoted price (Gateway's mock catalog)
// ends up with a Running total computed from the Live price, not Quoted.
describe("Live price-check vertical slice (issue #19)", () => {
  let network: NetworkBoundary;
  let gateway: GatewayMockServer;
  let cognito: CognitoMockServer;
  // Importing handler.ts triggers composition-root's eager construction —
  // done inside beforeAll so vi.mock above is guaranteed to be in place first.
  let app: typeof import("../../../src/concierge/infra/handler").app;

  beforeAll(async () => {
    ({ app } = await import("../../../src/concierge/infra/handler"));
    app.run({ port: PORT, host: "127.0.0.1" });
    await waitForHealthy(BASE_URL);
  });

  afterAll(async () => {
    await closeConciergeApp(app);
  });

  beforeEach(async () => {
    bedrockMock.reset();
    memoryMock.reset();
    memoryMock.on(CreateEventCommand).resolves({});
    memoryMock.on(ListEventsCommand).resolves({ events: [] });
    memoryMock.on(RetrieveMemoryRecordsCommand).resolves({ memoryRecordSummaries: [] });
    network = new NetworkBoundary();
    gateway = new GatewayMockServer(network.agent);
    cognito = await CognitoMockServer.register(network.agent);

    navigateMock.mockReset().mockResolvedValue(undefined);
    getTextMock.mockReset();
    stopSessionMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await network.close();
  });

  it("holds a Tokyo flight at its Live price and computes the Running total from Live, not Quoted, price", async () => {
    // Quoted price (Gateway's mock catalog): 82000 JPY. Live price (the mock
    // price-check site): 79500 JPY — deliberately different, per ADR-0005.
    gateway.respondToTool("search-flights", {
      content: [
        { candidateId: "flight-1", destination: "TOKYO", airline: "ANA", price: { amount: 82000, currency: "JPY" } },
      ],
    });
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-flight-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });
    getTextMock.mockResolvedValue(JSON.stringify({ amount: 79500, currency: "JPY" }));

    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock.on(InvokeCodeInterpreterCommand).resolves(
      aSandboxResult({ runningTotal: 532.65, breakdownByCity: { TOKYO: 532.65 }, breakdownByCategory: { FLIGHT: 532.65 } }),
    );

    const responses = [
      aToolUseResponse({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }),
      aToolUseResponse({ toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } }),
      aTextResponse("Your Tokyo flight is held at its live price."),
    ];
    let lastToolResultSeen: unknown;
    bedrockMock.on(ConverseCommand).callsFake((input: ConverseCommandInput) => {
      lastToolResultSeen = extractLastToolResult(input.messages);
      const next = responses.shift();
      if (!next) {
        throw new Error("ConverseCommand called more times than the test scripted");
      }
      return next;
    });

    const token = await cognito.signToken();
    const response = await invoke(
      BASE_URL,
      aSessionId("live-price"),
      "Hold the Tokyo flight",
      `Bearer ${token}`,
    );

    expect(await response.text()).toBe("Your Tokyo flight is held at its live price.");

    // The price-check ran (navigate + read) before the hold's tool result
    // ever reached the model.
    expect(navigateMock).toHaveBeenCalledWith({
      url: expect.stringContaining("candidateId=flight-1"),
    });
    expect(getTextMock).toHaveBeenCalledWith({ selector: "#live-price-json" });

    // The final round's tool result (hold-flight's) carries the Live price
    // and a Running total computed from it — not Quoted's 82000 JPY -> 549.4.
    expect(lastToolResultSeen).toMatchObject({
      livePrice: { amount: 79500, currency: "JPY" },
      budget: { runningTotal: 532.65, breakdownByCity: { TOKYO: 532.65 }, breakdownByCategory: { FLIGHT: 532.65 } },
    });
  });
});

function aSandboxResult(payload: unknown) {
  return {
    stream: codeInterpreterStream({ result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false } }),
  };
}

function aToolUseResponse(toolUse: { toolUseId: string; name: string; input: DocumentType }) {
  return {
    output: { message: { role: "assistant" as const, content: [{ toolUse }] } },
    stopReason: "tool_use" as const,
  };
}

function aTextResponse(text: string) {
  return { output: { message: { role: "assistant" as const, content: [{ text }] } } };
}

function extractLastToolResult(messages: ConverseCommandInput["messages"]): unknown {
  const lastMessage = messages?.[messages.length - 1];
  const toolResult = lastMessage?.content?.[0]?.toolResult;
  return toolResult?.content?.[0]?.json;
}

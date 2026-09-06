import {
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { CognitoMockServer } from "../support/cognito-network-boundary";
import { aSessionId, closeConciergeApp, invoke, waitForHealthy } from "../support/concierge-test-server";
import { GatewayMockServer } from "../support/gateway-network-boundary";
import { memoryMock } from "../support/memory-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

const navigateMock = vi.fn();
const getTextMock = vi.fn();
const stopSessionMock = vi.fn();

vi.mock("bedrock-agentcore/browser/playwright", () => ({
  PlaywrightBrowser: vi.fn().mockImplementation(() => ({
    navigate: navigateMock,
    getText: getTextMock,
    stopSession: stopSessionMock,
  })),
}));

const PORT = 41829;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Policy's Gated-hold approval gate (issue #20 / ADR-0006): a hold above the
// flat Local-currency threshold is DENYed, the Concierge surfaces the price
// and asks the Caller to approve, calling approve-hold and retrying the
// hold then succeeds — driven through the real Runtime entry point with
// only the network boundary (Gateway's MCP calls) mocked.
describe("Gated-hold approval round trip (issue #20 / ADR-0006)", () => {
  let network: NetworkBoundary;
  let gateway: GatewayMockServer;
  let cognito: CognitoMockServer;

  beforeAll(async () => {
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
    getTextMock.mockReset().mockResolvedValue(JSON.stringify({ amount: 900, currency: "JPY" }));
    stopSessionMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await network.close();
  });

  it("DENYs an expensive hold, ALLOWs it after approve-hold, and surfaces the price along the way", async () => {
    gateway.respondToTool("search-flights", {
      content: [
        { candidateId: "flight-1", destination: "TOKYO", airline: "ANA", price: { amount: 900, currency: "JPY" } },
      ],
    });
    gateway.respondToTool("hold-flight", {
      isError: true,
      content:
        "AuthorizeActionException - Tool Execution Denied: Tool call not allowed due to policy enforcement [No policy applies to the request (denied by default).]",
    });
    gateway.respondToTool("approve-hold", { content: { approved: true } });
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-flight-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }),
      )
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } }),
      )
      .resolvesOnce(aTextResponse("This flight costs 900 JPY, above your approval threshold — approve it?"))
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-3", name: "approve-hold", input: {} }),
      )
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-4", name: "hold-flight", input: { candidateId: "flight-1" } }),
      )
      .resolvesOnce(aTextResponse("Approved and held!"));

    const token = await cognito.signToken();
    const sessionId = aSessionId("gated-hold");

    const firstResponse = await invoke(
      BASE_URL,
      sessionId,
      "Hold the Tokyo flight",
      `Bearer ${token}`,
    );
    expect(await firstResponse.text()).toBe(
      "This flight costs 900 JPY, above your approval threshold — approve it?",
    );

    const secondResponse = await invoke(BASE_URL, sessionId, "Yes, approve it", `Bearer ${token}`);
    expect(await secondResponse.text()).toBe("Approved and held!");

    expect(gateway.receivedToolCalls.filter((call) => call.name === "hold-flight")).toHaveLength(2);
    expect(gateway.receivedToolCalls.some((call) => call.name === "approve-hold")).toBe(true);
  });

  it("passes below the threshold with no approval step", async () => {
    getTextMock.mockResolvedValue(JSON.stringify({ amount: 100, currency: "JPY" }));
    gateway.respondToTool("search-flights", {
      content: [
        { candidateId: "flight-1", destination: "TOKYO", airline: "ANA", price: { amount: 100, currency: "JPY" } },
      ],
    });
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-flight-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }),
      )
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } }),
      )
      .resolvesOnce(aTextResponse("Held, no approval needed."));

    const token = await cognito.signToken();
    const response = await invoke(BASE_URL, aSessionId("ungated-hold"), "Hold the Tokyo flight", `Bearer ${token}`);

    expect(await response.text()).toBe("Held, no approval needed.");
    expect(gateway.receivedToolCalls.some((call) => call.name === "approve-hold")).toBe(false);
  });
});

function aToolUseResponse(toolUse: { toolUseId: string; name: string; input: DocumentType }) {
  return {
    output: { message: { role: "assistant" as const, content: [{ toolUse }] } },
    stopReason: "tool_use" as const,
  };
}

function aTextResponse(text: string) {
  return { output: { message: { role: "assistant" as const, content: [{ text }] } } };
}

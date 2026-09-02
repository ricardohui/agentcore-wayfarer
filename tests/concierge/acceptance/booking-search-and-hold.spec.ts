import {
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { CognitoMockServer } from "../support/cognito-network-boundary";
import { aSessionId, closeConciergeApp, invoke, waitForHealthy } from "../support/concierge-test-server";
import { GatewayMockServer } from "../support/gateway-network-boundary";
import { memoryMock } from "../support/memory-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

const PORT = 41824;
const BASE_URL = `http://127.0.0.1:${PORT}`;

describe("Booking search-and-hold vertical slice (REQ-GATEWAY-001, REQ-GATEWAY-002, REQ-GATEWAY-003)", () => {
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
  });

  afterEach(async () => {
    await network.close();
  });

  it("searches and holds a flight and a hotel for a 3-city trip request, driven through the real Runtime entry point", async () => {
    gateway.respondToTool("search-flights", {
      content: [
        { candidateId: "flight-1", destination: "TOKYO", airline: "ANA", price: { amount: 82000, currency: "JPY" } },
      ],
    });
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-flight-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });
    gateway.respondToTool("search-hotels", {
      content: [
        { candidateId: "hotel-1", city: "TOKYO", hotelName: "Park Hyatt Tokyo", price: { amount: 45000, currency: "JPY" } },
      ],
    });
    gateway.respondToTool("hold-hotel", {
      content: { holdId: "hold-hotel-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }),
      )
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } }),
      )
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-3", name: "search-hotels", input: { city: "TOKYO" } }),
      )
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-4", name: "hold-hotel", input: { candidateId: "hotel-1" } }),
      )
      .resolvesOnce(aTextResponse("Your Tokyo flight and hotel are both held!"));

    const token = await cognito.signToken();
    const response = await invoke(
      BASE_URL,
      aSessionId("booking"),
      "Plan me a trip to Tokyo and hold a flight and a hotel",
      `Bearer ${token}`,
    );

    expect(await response.text()).toBe("Your Tokyo flight and hotel are both held!");
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

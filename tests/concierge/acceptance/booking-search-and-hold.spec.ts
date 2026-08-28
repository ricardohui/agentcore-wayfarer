import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { GatewayMockServer } from "../support/gateway-network-boundary";

const PORT = 41824;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SESSION_ID_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

describe("Booking search-and-hold vertical slice (REQ-GATEWAY-001, REQ-GATEWAY-002, REQ-GATEWAY-003)", () => {
  let gateway: GatewayMockServer;

  beforeAll(async () => {
    app.run({ port: PORT, host: "127.0.0.1" });
    await waitForHealthy();
  });

  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    bedrockMock.reset();
    gateway = new GatewayMockServer();
  });

  afterEach(async () => {
    await gateway.close();
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

    const reply = await invoke(aSessionId("booking"), "Plan me a trip to Tokyo and hold a flight and a hotel");

    expect(reply).toBe("Your Tokyo flight and hotel are both held!");
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

function aSessionId(suffix: string): string {
  return `acceptance-test-session-${suffix}`.padEnd(33, "-");
}

async function invoke(sessionId: string, message: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json", [SESSION_ID_HEADER]: sessionId },
    body: JSON.stringify({ message }),
  });
  return response.text();
}

async function waitForHealthy(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/ping`);
      if (response.ok) {
        return;
      }
    } catch {
      // server not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Concierge server did not become healthy in time");
}

function closeApp(): Promise<void> {
  return (app as unknown as { _app: { close: () => Promise<void> } })._app.close();
}

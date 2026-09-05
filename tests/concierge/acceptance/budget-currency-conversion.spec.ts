import {
  CreateEventCommand,
  InvokeCodeInterpreterCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
  StartCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { codeInterpreterStream } from "../support/code-interpreter-stream";
import { CognitoMockServer } from "../support/cognito-network-boundary";
import { aSessionId, closeConciergeApp, invoke, waitForHealthy } from "../support/concierge-test-server";
import { GatewayMockServer } from "../support/gateway-network-boundary";
import { memoryMock } from "../support/memory-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

const PORT = 41827;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Issue #18 / ADR-0004: a held flight and a held hotel, priced in two
// different Local currencies, both fold into one Code Interpreter sandbox
// session's Running total and Budget breakdown.
describe("Budget/currency conversion vertical slice (issue #18)", () => {
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

  it("converts a held flight (JPY) and a held hotel (EUR) into one accumulating Home-currency Running total and breakdown", async () => {
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
        { candidateId: "hotel-1", city: "PARIS", hotelName: "Hotel de Ville", price: { amount: 150, currency: "EUR" } },
      ],
    });
    gateway.respondToTool("hold-hotel", {
      content: { holdId: "hold-hotel-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock
      .on(InvokeCodeInterpreterCommand)
      .resolvesOnce(
        aSandboxResult({ runningTotal: 549.4, breakdownByCity: { TOKYO: 549.4 }, breakdownByCategory: { FLIGHT: 549.4 } }),
      )
      .resolvesOnce(
        aSandboxResult({
          runningTotal: 711.4,
          breakdownByCity: { TOKYO: 549.4, PARIS: 162 },
          breakdownByCategory: { FLIGHT: 549.4, HOTEL: 162 },
        }),
      );

    // BedrockConverseModelClient mutates and reuses one `messages` array
    // across every round, so a mock that snapshots `input.messages` only
    // when send() is actually called (not read back afterwards, by which
    // point later rounds have already appended to that same array) is what
    // proves what each individual round actually saw.
    const messagesSeenByRound: ConverseCommandInput["messages"][] = [];
    const responses = [
      aToolUseResponse({ toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } }),
      aToolUseResponse({ toolUseId: "call-2", name: "hold-flight", input: { candidateId: "flight-1" } }),
      aToolUseResponse({ toolUseId: "call-3", name: "search-hotels", input: { city: "PARIS" } }),
      aToolUseResponse({ toolUseId: "call-4", name: "hold-hotel", input: { candidateId: "hotel-1" } }),
      aTextResponse("Your Tokyo flight and Paris hotel are both held!"),
    ];
    bedrockMock.on(ConverseCommand).callsFake((input: ConverseCommandInput) => {
      messagesSeenByRound.push(structuredClone(input.messages));
      const next = responses.shift();
      if (!next) {
        throw new Error("ConverseCommand called more times than the test scripted");
      }
      return next;
    });

    const token = await cognito.signToken();
    const response = await invoke(
      BASE_URL,
      aSessionId("budget"),
      "Plan me a trip: hold a Tokyo flight and a Paris hotel",
      `Bearer ${token}`,
    );

    expect(await response.text()).toBe("Your Tokyo flight and Paris hotel are both held!");

    // One sandbox session for the whole conversation, reused across both
    // holds (issue #18's "one session persists across multiple holds").
    expect(memoryMock.commandCalls(StartCodeInterpreterSessionCommand)).toHaveLength(1);

    // Round 2's request carries the hold-flight toolResult; round 4's
    // carries the hold-hotel toolResult (rounds 1/3 only carry search
    // results, which have no budget field).
    expect(lastToolResult(messagesSeenByRound[2])).toMatchObject({
      budget: { runningTotal: 549.4, breakdownByCity: { TOKYO: 549.4 }, breakdownByCategory: { FLIGHT: 549.4 } },
    });
    expect(lastToolResult(messagesSeenByRound[4])).toMatchObject({
      budget: {
        runningTotal: 711.4,
        breakdownByCity: { TOKYO: 549.4, PARIS: 162 },
        breakdownByCategory: { FLIGHT: 549.4, HOTEL: 162 },
      },
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

function lastToolResult(messages: ConverseCommandInput["messages"]): unknown {
  const lastMessage = messages?.[messages.length - 1];
  const toolResult = lastMessage?.content?.[0]?.toolResult;
  return toolResult?.content?.[0]?.json;
}

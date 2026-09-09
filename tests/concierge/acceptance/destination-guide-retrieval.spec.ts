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

const PORT = 41830;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Knowledge Base's destination-guide retrieval (REQ-KB-001, REQ-KB-002,
// REQ-KB-003, issue #21 / ADR-0009): a destination question is answered
// using retrieved Knowledge Base content, not the model's unaided knowledge
// — driven through the real Runtime entry point, network boundary mocked at
// Gateway's Knowledge Base connector target.
describe("Destination-guide retrieval via Gateway (REQ-KB-001, REQ-KB-002, REQ-KB-003)", () => {
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

  it("answers a destination question using content retrieved from the Knowledge Base", async () => {
    gateway.respondToTool("Retrieve", {
      content: {
        retrievalResults: [
          {
            content: {
              type: "TEXT",
              text: "Travelers from the US, UK, EU, Canada, and Australia can enter Japan visa-free for stays of up to 90 days.",
            },
            location: { type: "S3", s3Location: { uri: "s3://wayfarer-destination-guides/tokyo.md" } },
            score: 0.91,
          },
        ],
      },
    });

    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(
        aToolUseResponse({
          toolUseId: "call-1",
          name: "retrieve-destination-guide",
          input: { query: "visa situation for Tokyo" },
        }),
      )
      .resolvesOnce(
        aTextResponse(
          "Travelers from the US, UK, EU, Canada, and Australia can enter Japan visa-free for stays of up to 90 days.",
        ),
      );

    const token = await cognito.signToken();
    const response = await invoke(
      BASE_URL,
      aSessionId("destination-guide"),
      "What's the visa situation for Tokyo?",
      `Bearer ${token}`,
    );

    expect(await response.text()).toBe(
      "Travelers from the US, UK, EU, Canada, and Australia can enter Japan visa-free for stays of up to 90 days.",
    );
    expect(gateway.receivedToolCalls).toMatchObject([
      { name: "Retrieve", arguments: { retrievalQuery: { text: "visa situation for Tokyo" } } },
    ]);
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

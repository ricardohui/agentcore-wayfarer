import {
  CreateEventCommand,
  GetResourceOauth2TokenCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { CalendarMockServer } from "../support/calendar-network-boundary";
import { CognitoMockServer } from "../support/cognito-network-boundary";
import { aSessionId, closeConciergeApp, invoke, waitForHealthy } from "../support/concierge-test-server";
import { memoryMock } from "../support/memory-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

const PORT = 41826;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WORKLOAD_ACCESS_TOKEN_HEADER = "WorkloadAccessToken";
const AUTHORIZATION_URL = "https://calendar-oauth.example.com/authorize?state=abc123";

describe("Identity: consent handshake then calendar write (REQ-IDENTITY-002 through REQ-IDENTITY-006, issue #17 / ADR-0003)", () => {
  let network: NetworkBoundary;
  let cognito: CognitoMockServer;
  let calendar: CalendarMockServer;

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
    cognito = await CognitoMockServer.register(network.agent);
    calendar = new CalendarMockServer(network.agent);
  });

  afterEach(async () => {
    await network.close();
  });

  async function invokeWithWorkloadIdentity(sessionId: string, message: string, workloadAccessToken: string) {
    const token = await cognito.signToken();
    const response = await fetch(`${BASE_URL}/invocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
        authorization: `Bearer ${token}`,
        [WORKLOAD_ACCESS_TOKEN_HEADER]: workloadAccessToken,
      },
      body: JSON.stringify({ message }),
    });
    return response.text();
  }

  it("surfaces the authorization URL on first attempt, then writes the event on retry once consent is on file", async () => {
    memoryMock
      .on(GetResourceOauth2TokenCommand)
      .resolvesOnce({ authorizationUrl: AUTHORIZATION_URL })
      .resolves({ accessToken: "vaulted-calendar-access-token" });

    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-1", name: "write-calendar-event", input: { holdId: "hold-1", title: "Tokyo trip" } }),
      )
      .resolvesOnce(aTextResponse(`Please approve calendar access: ${AUTHORIZATION_URL}`))
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-2", name: "write-calendar-event", input: { holdId: "hold-1", title: "Tokyo trip" } }),
      )
      .resolvesOnce(aTextResponse("Your Tokyo trip is on the calendar!"));

    const firstReply = await invokeWithWorkloadIdentity(
      aSessionId("consent"),
      "Add my Tokyo trip to my calendar",
      "workload-access-token-1",
    );
    expect(firstReply).toBe(`Please approve calendar access: ${AUTHORIZATION_URL}`);
    expect(calendar.writtenEvents).toEqual([]);

    const secondReply = await invokeWithWorkloadIdentity(
      aSessionId("consent"),
      "I've approved it, please try again",
      "workload-access-token-1",
    );
    expect(secondReply).toBe("Your Tokyo trip is on the calendar!");
    expect(calendar.writtenEvents).toEqual([
      { holdId: "hold-1", title: "Tokyo trip", authorizationHeader: "Bearer vaulted-calendar-access-token" },
    ]);
  });

  it("does not re-trigger the consent handshake on a later calendar write for the same Caller", async () => {
    memoryMock.on(GetResourceOauth2TokenCommand).resolves({ accessToken: "vaulted-calendar-access-token" });
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(
        aToolUseResponse({ toolUseId: "call-1", name: "write-calendar-event", input: { holdId: "hold-2", title: "Paris trip" } }),
      )
      .resolvesOnce(aTextResponse("Your Paris trip is on the calendar!"));

    const reply = await invokeWithWorkloadIdentity(
      aSessionId("already-consented"),
      "Add my Paris trip to my calendar",
      "workload-access-token-1",
    );

    expect(reply).toBe("Your Paris trip is on the calendar!");
    expect(calendar.writtenEvents).toEqual([
      { holdId: "hold-2", title: "Paris trip", authorizationHeader: "Bearer vaulted-calendar-access-token" },
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

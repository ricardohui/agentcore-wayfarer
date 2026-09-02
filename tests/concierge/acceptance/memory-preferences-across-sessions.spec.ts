import { CreateEventCommand, ListEventsCommand, RetrieveMemoryRecordsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActorId } from "../../../src/concierge/domain/actor-id";
import { app } from "../../../src/concierge/infra/handler";
import { semanticPreferenceNamespace, userPreferenceNamespace } from "../../../src/concierge/memory-namespaces";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { CognitoMockServer, DEFAULT_TEST_SUB } from "../support/cognito-network-boundary";
import { aSessionId, closeConciergeApp, invoke, waitForHealthy } from "../support/concierge-test-server";
import { memoryMock } from "../support/memory-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

const PORT = 41825;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// The Concierge's actorId is the Caller's Cognito `sub` claim (issue #17 /
// ADR-0003) — CognitoMockServer signs tokens for DEFAULT_TEST_SUB by default.
const ACTOR_ID = DEFAULT_TEST_SUB as ActorId;

describe("Memory: long-term preference recall across sessions (REQ-MEMORY-002, issue #16)", () => {
  let network: NetworkBoundary;
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
    memoryMock
      .on(RetrieveMemoryRecordsCommand, { namespace: semanticPreferenceNamespace(ACTOR_ID) })
      .resolves({ memoryRecordSummaries: [] });
    network = new NetworkBoundary();
    cognito = await CognitoMockServer.register(network.agent);
  });

  afterEach(async () => {
    await network.close();
  });

  it("recognizes a returning actor by a preference extracted since their last session", async () => {
    const preferenceText = "home airport: NRT";
    // The first session's own conversation hasn't been extracted into a
    // long-term preference yet — only the second session's lookup finds it,
    // standing in for the Strategies' async extraction having since run.
    memoryMock
      .on(RetrieveMemoryRecordsCommand, { namespace: userPreferenceNamespace(ACTOR_ID) })
      .resolvesOnce({ memoryRecordSummaries: [] })
      .resolves({ memoryRecordSummaries: [aMemoryRecordSummary(preferenceText)] });

    bedrockMock.on(ConverseCommand).callsFake((input) => {
      const systemText = input.system?.[0]?.text ?? "";
      return aConverseResponse(
        systemText.includes(preferenceText) ? `Welcome back — flying from NRT again?` : "Let's plan your trip!",
      );
    });

    const token = await cognito.signToken();
    const firstReply = await invoke(BASE_URL, aSessionId("first"), "Hi, plan me a trip to Tokyo", `Bearer ${token}`);
    const secondReply = await invoke(BASE_URL, aSessionId("second"), "Hi again", `Bearer ${token}`);

    expect(await firstReply.text()).toBe("Let's plan your trip!");
    expect(await secondReply.text()).toBe("Welcome back — flying from NRT again?");
  });
});

function aMemoryRecordSummary(text: string) {
  return {
    memoryRecordId: "record-1",
    content: { text },
    memoryStrategyId: "wayfarer_user_preference",
    namespaces: [userPreferenceNamespace(ACTOR_ID)],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function aConverseResponse(text: string) {
  return { output: { message: { role: "assistant" as const, content: [{ text }] } } };
}

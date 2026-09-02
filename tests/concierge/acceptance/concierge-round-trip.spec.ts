import {
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand, ThrottlingException } from "@aws-sdk/client-bedrock-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { CognitoMockServer } from "../support/cognito-network-boundary";
import { aSessionId, closeConciergeApp, invoke, waitForHealthy } from "../support/concierge-test-server";
import { memoryMock } from "../support/memory-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

const PORT = 41823;
const BASE_URL = `http://127.0.0.1:${PORT}`;

describe("Concierge round trip (REQ-RUNTIME-001, REQ-RUNTIME-002, REQ-RUNTIME-003)", () => {
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
    memoryMock.on(RetrieveMemoryRecordsCommand).resolves({ memoryRecordSummaries: [] });
    network = new NetworkBoundary();
    cognito = await CognitoMockServer.register(network.agent);
  });

  afterEach(async () => {
    await network.close();
  });

  it("passes its health check", async () => {
    const response = await fetch(`${BASE_URL}/ping`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("Healthy");
  });

  it("answers a Caller message through the real entry point (REQ-RUNTIME-001, REQ-RUNTIME-003)", async () => {
    bedrockMock.on(ConverseCommand).resolves(aConverseResponse("Let's plan your trip!"));

    const token = await cognito.signToken();
    const response = await invoke(BASE_URL, aSessionId("round-trip"), "Plan me a trip to Tokyo", `Bearer ${token}`);

    expect(await response.text()).toBe("Let's plan your trip!");
  });

  it("rejects a request with no Authorization header before reaching the usecase (REQ-IDENTITY-001)", async () => {
    const response = await fetch(`${BASE_URL}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-amzn-bedrock-agentcore-runtime-session-id": aSessionId("unauth") },
      body: JSON.stringify({ message: "Plan me a trip to Tokyo" }),
    });

    // An unauthenticated request is an expected, recoverable failure (like a
    // malformed message) — a safe reply, not a thrown 500 — but the usecase
    // (and therefore the model) is never reached.
    expect(response.status).toBe(200);
    expect(await response.text()).not.toBe("Let's plan your trip!");
    expect(bedrockMock.calls()).toHaveLength(0);
  });

  it("rejects a request with an invalid-signature token before reaching the usecase (REQ-IDENTITY-001)", async () => {
    const response = await invoke(
      BASE_URL,
      aSessionId("bad-token"),
      "Plan me a trip to Tokyo",
      "Bearer not-a-real-jwt",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toBe("Let's plan your trip!");
    expect(bedrockMock.calls()).toHaveLength(0);
  });

  it("keeps two Runtime sessions isolated (REQ-RUNTIME-002, REQ-MEMORY-001)", async () => {
    const sessionAId = aSessionId("session-a");
    // Memory's get_last_k_turns is session-scoped (issue #16) — simulate
    // session A already having a prior turn on file, and confirm session B's
    // ListEvents call (a different sessionId) never sees it.
    memoryMock.on(ListEventsCommand).callsFake((input) =>
      input.sessionId === sessionAId
        ? {
            events: [
              {
                eventId: "event-a-1",
                payload: [
                  { conversational: { role: "USER", content: { text: "I only exist in session A" } } },
                  { conversational: { role: "ASSISTANT", content: { text: "Noted!" } } },
                ],
              },
            ],
          }
        : { events: [] },
    );
    bedrockMock.on(ConverseCommand).callsFake((input) => {
      const turnsSeenByModel = input.messages?.length ?? 0;
      return aConverseResponse(`turns-seen:${turnsSeenByModel}`);
    });

    const token = await cognito.signToken();
    await invoke(BASE_URL, sessionAId, "I only exist in session A", `Bearer ${token}`);
    const replyToSessionB = await invoke(BASE_URL, aSessionId("session-b"), "What did I say before?", `Bearer ${token}`);

    expect(await replyToSessionB.text()).toBe("turns-seen:1");
  });

  it("returns a safe message when the model client fails, without leaking internal error detail", async () => {
    bedrockMock
      .on(ConverseCommand)
      .rejects(new ThrottlingException({ message: "internal throttling detail", $metadata: {} }));

    const token = await cognito.signToken();
    const response = await invoke(BASE_URL, aSessionId("model-down"), "Plan me a trip to Tokyo", `Bearer ${token}`);
    const reply = await response.text();

    expect(response.status).toBe(200);
    expect(reply).not.toContain("internal throttling detail");
  });
});

function aConverseResponse(text: string) {
  return { output: { message: { role: "assistant" as const, content: [{ text }] } } };
}

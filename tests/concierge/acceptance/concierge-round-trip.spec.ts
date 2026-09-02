import {
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand, ThrottlingException } from "@aws-sdk/client-bedrock-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { memoryMock } from "../support/memory-network-boundary";

const PORT = 41823;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SESSION_ID_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

describe("Concierge round trip (REQ-RUNTIME-001, REQ-RUNTIME-002, REQ-RUNTIME-003)", () => {
  beforeAll(async () => {
    app.run({ port: PORT, host: "127.0.0.1" });
    await waitForHealthy();
  });

  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    bedrockMock.reset();
    memoryMock.reset();
    memoryMock.on(CreateEventCommand).resolves({});
    memoryMock.on(ListEventsCommand).resolves({ events: [] });
    memoryMock.on(RetrieveMemoryRecordsCommand).resolves({ memoryRecordSummaries: [] });
  });

  it("passes its health check", async () => {
    const response = await fetch(`${BASE_URL}/ping`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("Healthy");
  });

  it("answers a Caller message through the real entry point (REQ-RUNTIME-001, REQ-RUNTIME-003)", async () => {
    bedrockMock.on(ConverseCommand).resolves(aConverseResponse("Let's plan your trip!"));

    const reply = await invoke(aSessionId("round-trip"), "Plan me a trip to Tokyo");

    expect(reply).toBe("Let's plan your trip!");
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

    await invoke(sessionAId, "I only exist in session A");
    const replyToSessionB = await invoke(aSessionId("session-b"), "What did I say before?");

    expect(replyToSessionB).toBe("turns-seen:1");
  });

  it("returns a safe message when the model client fails, without leaking internal error detail", async () => {
    bedrockMock
      .on(ConverseCommand)
      .rejects(new ThrottlingException({ message: "internal throttling detail", $metadata: {} }));

    const response = await fetch(`${BASE_URL}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json", [SESSION_ID_HEADER]: aSessionId("model-down") },
      body: JSON.stringify({ message: "Plan me a trip to Tokyo" }),
    });
    const reply = await response.text();

    expect(response.status).toBe(200);
    expect(reply).not.toContain("internal throttling detail");
  });
});

function aConverseResponse(text: string) {
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

// bedrock-agentcore@0.4.3 exposes no public stop()/close() — reach into the
// underlying Fastify instance (its documented internal field is named `_app`)
// to tear the server down between test files.
function closeApp(): Promise<void> {
  return (app as unknown as { _app: { close: () => Promise<void> } })._app.close();
}

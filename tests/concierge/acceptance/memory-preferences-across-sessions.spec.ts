import { CreateEventCommand, ListEventsCommand, RetrieveMemoryRecordsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../../src/concierge/infra/handler";
import { PLACEHOLDER_ACTOR_ID } from "../../../src/concierge/infra/placeholder-actor-id";
import { semanticPreferenceNamespace, userPreferenceNamespace } from "../../../src/concierge/memory-namespaces";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { memoryMock } from "../support/memory-network-boundary";

const PORT = 41825;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SESSION_ID_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

describe("Memory: long-term preference recall across sessions (REQ-MEMORY-002, issue #16)", () => {
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
    memoryMock
      .on(RetrieveMemoryRecordsCommand, { namespace: semanticPreferenceNamespace(PLACEHOLDER_ACTOR_ID) })
      .resolves({ memoryRecordSummaries: [] });
  });

  it("recognizes a returning actor by a preference extracted since their last session", async () => {
    const preferenceText = "home airport: NRT";
    // The first session's own conversation hasn't been extracted into a
    // long-term preference yet — only the second session's lookup finds it,
    // standing in for the Strategies' async extraction having since run.
    memoryMock
      .on(RetrieveMemoryRecordsCommand, { namespace: userPreferenceNamespace(PLACEHOLDER_ACTOR_ID) })
      .resolvesOnce({ memoryRecordSummaries: [] })
      .resolves({ memoryRecordSummaries: [aMemoryRecordSummary(preferenceText)] });

    bedrockMock.on(ConverseCommand).callsFake((input) => {
      const systemText = input.system?.[0]?.text ?? "";
      return aConverseResponse(
        systemText.includes(preferenceText) ? `Welcome back — flying from NRT again?` : "Let's plan your trip!",
      );
    });

    const firstReply = await invoke("first", "Hi, plan me a trip to Tokyo");
    const secondReply = await invoke("second", "Hi again");

    expect(firstReply).toBe("Let's plan your trip!");
    expect(secondReply).toBe("Welcome back — flying from NRT again?");
  });
});

function aMemoryRecordSummary(text: string) {
  return {
    memoryRecordId: "record-1",
    content: { text },
    memoryStrategyId: "wayfarer_user_preference",
    namespaces: [userPreferenceNamespace(PLACEHOLDER_ACTOR_ID)],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function aConverseResponse(text: string) {
  return { output: { message: { role: "assistant" as const, content: [{ text }] } } };
}

function aSessionId(suffix: string): string {
  return `acceptance-test-session-${suffix}`.padEnd(33, "-");
}

async function invoke(sessionSuffix: string, message: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json", [SESSION_ID_HEADER]: aSessionId(sessionSuffix) },
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

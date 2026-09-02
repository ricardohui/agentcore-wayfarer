import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
  ThrottledException,
  type Event,
  type PayloadType,
} from "@aws-sdk/client-bedrock-agentcore";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentCoreMemoryAdapter } from "../../../src/concierge/adapter/agentcore-memory-adapter";
import {
  semanticPreferenceNamespace,
  userPreferenceNamespace,
} from "../../../src/concierge/memory-namespaces";
import { memoryMock } from "../support/memory-network-boundary";
import { aCallerMessage, aConciergeReply, anActorId, aRuntimeSessionId } from "../support/object-mothers";

const MEMORY_ID = "test-memory-id";

describe("AgentCoreMemoryAdapter", () => {
  let adapter: AgentCoreMemoryAdapter;

  beforeEach(() => {
    memoryMock.reset();
    adapter = new AgentCoreMemoryAdapter(new BedrockAgentCoreClient({}), MEMORY_ID);
  });

  describe("recordTurn", () => {
    it("creates one event carrying a USER and an ASSISTANT payload", async () => {
      memoryMock.on(CreateEventCommand).resolves({});
      const sessionId = aRuntimeSessionId();
      const actorId = anActorId();
      const message = aCallerMessage("Plan me a trip to Tokyo");
      const reply = aConciergeReply("Let's start with your dates.");

      const result = await adapter.recordTurn(sessionId, actorId, { message, reply });

      expect(result).toEqual({ ok: true, value: undefined });
      const calls = memoryMock.commandCalls(CreateEventCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0].input).toMatchObject({
        memoryId: MEMORY_ID,
        actorId,
        sessionId,
        payload: [
          { conversational: { role: "USER", content: { text: message } } },
          { conversational: { role: "ASSISTANT", content: { text: reply } } },
        ],
      });
    });

    it("translates a service failure into a typed MemoryUnavailable error", async () => {
      memoryMock.on(CreateEventCommand).rejects(new ThrottledException({ message: "slow down", $metadata: {} }));

      const result = await adapter.recordTurn(aRuntimeSessionId(), anActorId(), {
        message: aCallerMessage("Hi"),
        reply: aConciergeReply("Hello"),
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.type).toBe("MemoryUnavailable");
    });
  });

  describe("getRecentTurns", () => {
    it("returns an empty transcript for a fresh session with no prior events", async () => {
      memoryMock.on(ListEventsCommand).resolves({ events: [] });

      const result = await adapter.getRecentTurns(aRuntimeSessionId(), anActorId(), 20);

      expect(result).toEqual({ ok: true, value: [] });
    });

    it("reconstructs turns from newest-first events into chronological order", async () => {
      memoryMock.on(ListEventsCommand).resolves({
        events: [
          anEvent("event-2", [
            { conversational: { role: "USER", content: { text: "second message" } } },
            { conversational: { role: "ASSISTANT", content: { text: "second reply" } } },
          ]),
          anEvent("event-1", [
            { conversational: { role: "USER", content: { text: "first message" } } },
            { conversational: { role: "ASSISTANT", content: { text: "first reply" } } },
          ]),
        ],
      });

      const result = await adapter.getRecentTurns(aRuntimeSessionId(), anActorId(), 20);

      expect(result).toEqual({
        ok: true,
        value: [
          { message: "first message", reply: "first reply" },
          { message: "second message", reply: "second reply" },
        ],
      });
    });

    it("skips an event missing its ASSISTANT half rather than discarding every other turn", async () => {
      memoryMock.on(ListEventsCommand).resolves({
        events: [
          anEvent("event-2", [
            { conversational: { role: "USER", content: { text: "second message" } } },
            { conversational: { role: "ASSISTANT", content: { text: "second reply" } } },
          ]),
          anEvent("event-1", [{ conversational: { role: "USER", content: { text: "incomplete" } } }]),
        ],
      });

      const result = await adapter.getRecentTurns(aRuntimeSessionId(), anActorId(), 20);

      expect(result).toEqual({ ok: true, value: [{ message: "second message", reply: "second reply" }] });
    });
  });

  describe("getPreferences", () => {
    it("merges records from both the user-preference and semantic namespaces", async () => {
      const actorId = anActorId();
      memoryMock
        .on(RetrieveMemoryRecordsCommand, { memoryId: MEMORY_ID, namespace: userPreferenceNamespace(actorId) })
        .resolves({ memoryRecordSummaries: [aMemoryRecordSummary("home airport: NRT")] });
      memoryMock
        .on(RetrieveMemoryRecordsCommand, { memoryId: MEMORY_ID, namespace: semanticPreferenceNamespace(actorId) })
        .resolves({ memoryRecordSummaries: [aMemoryRecordSummary("avoids red-eyes")] });

      const result = await adapter.getPreferences(actorId);

      expect(result).toEqual({ ok: true, value: ["home airport: NRT", "avoids red-eyes"] });
    });

    it("returns an empty list for an actor with no extracted preferences yet", async () => {
      memoryMock.on(RetrieveMemoryRecordsCommand).resolves({ memoryRecordSummaries: [] });

      const result = await adapter.getPreferences(anActorId());

      expect(result).toEqual({ ok: true, value: [] });
    });
  });
});

function anEvent(eventId: string, payload: PayloadType[]): Event {
  return {
    eventId,
    payload,
    memoryId: MEMORY_ID,
    actorId: undefined,
    sessionId: undefined,
    eventTimestamp: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function aMemoryRecordSummary(text: string) {
  return {
    memoryRecordId: "record-1",
    content: { text },
    memoryStrategyId: "strategy-1",
    namespaces: ["/actor/test/preferences"],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

import { beforeEach, describe, expect, it } from "vitest";
import { ok, err, type Result } from "../../../src/concierge/domain/result";
import { InMemorySessionLock } from "../../../src/concierge/adapter/in-memory-session-lock";
import { respondToCallerMessage } from "../../../src/concierge/usecase/respond-to-caller-message";
import type { ConciergeReply } from "../../../src/concierge/domain/concierge-reply";
import type { ModelClient, ModelError } from "../../../src/concierge/usecase/ports";
import { FakeMemoryPort, FakeModelClient, FakeToolExecutor } from "../support/fakes";
import {
  aCallerMessage,
  aCallerPreference,
  aConciergeReply,
  anActorId,
  aRuntimeSessionId,
} from "../support/object-mothers";

describe("respondToCallerMessage", () => {
  let modelClient: FakeModelClient;
  let memory: FakeMemoryPort;
  let sessionLock: InMemorySessionLock;
  let toolExecutor: FakeToolExecutor;

  beforeEach(() => {
    modelClient = new FakeModelClient(ok(aConciergeReply()));
    memory = new FakeMemoryPort();
    sessionLock = new InMemorySessionLock();
    toolExecutor = new FakeToolExecutor();
  });

  it("returns the model's reply and records the turn to Memory", async () => {
    const sessionId = aRuntimeSessionId();
    const actorId = anActorId();
    const message = aCallerMessage("Plan me a trip to Tokyo");
    const reply = aConciergeReply("Let's start with your travel dates.");
    modelClient.respondWith(ok(reply));

    const result = await respondToCallerMessage(
      { modelClient, memory, sessionLock, toolExecutor },
      sessionId,
      actorId,
      message,
    );

    expect(result).toEqual({ ok: true, value: reply });
    expect(memory.recordedTurns).toEqual([{ sessionId, actorId, turn: { message, reply } }]);
  });

  it("passes the composition root's toolExecutor straight through to the model client", async () => {
    await respondToCallerMessage(
      { modelClient, memory, sessionLock, toolExecutor },
      aRuntimeSessionId(),
      anActorId(),
      aCallerMessage("Plan me a trip to Tokyo"),
    );

    expect(modelClient.receivedToolExecutors).toEqual([toolExecutor]);
  });

  it("gives the model client only the requesting session's recent turns", async () => {
    const sessionA = aRuntimeSessionId("a");
    const sessionB = aRuntimeSessionId("b");
    const actorId = anActorId();
    await respondToCallerMessage(
      { modelClient, memory, sessionLock, toolExecutor },
      sessionA,
      actorId,
      aCallerMessage("I only exist in session A"),
    );

    await respondToCallerMessage(
      { modelClient, memory, sessionLock, toolExecutor },
      sessionB,
      actorId,
      aCallerMessage("What did I say before?"),
    );

    const transcriptSeenBySessionB = modelClient.receivedTranscripts[1];
    expect(transcriptSeenBySessionB).toEqual([]);
  });

  it("passes the actor's stored preferences to the model client", async () => {
    const actorId = anActorId();
    const preference = aCallerPreference("avoids red-eyes");
    memory.givePreferences(actorId, [preference]);

    await respondToCallerMessage(
      { modelClient, memory, sessionLock, toolExecutor },
      aRuntimeSessionId(),
      actorId,
      aCallerMessage("Plan me a trip to Tokyo"),
    );

    expect(modelClient.receivedPreferences).toEqual([[preference]]);
  });

  it("does not record a turn when the model client fails", async () => {
    const sessionId = aRuntimeSessionId();
    const modelError = { type: "ModelUnavailable" as const, message: "throttled" };
    modelClient.respondWith(err(modelError));

    const result = await respondToCallerMessage(
      { modelClient, memory, sessionLock, toolExecutor },
      sessionId,
      anActorId(),
      aCallerMessage("Plan me a trip to Tokyo"),
    );

    expect(result).toEqual({ ok: false, error: modelError });
    expect(memory.recordedTurns).toEqual([]);
  });

  it("serializes two concurrent calls for the same session so neither turn is lost", async () => {
    const sessionId = aRuntimeSessionId();
    const actorId = anActorId();
    let resolveFirstReply!: (result: Result<ConciergeReply, ModelError>) => void;
    const firstReplyPending = new Promise<Result<ConciergeReply, ModelError>>((resolve) => {
      resolveFirstReply = resolve;
    });
    let generateReplyCalls = 0;
    const slowModelClient: ModelClient = {
      generateReply: async (_transcript, _message, _toolExecutor, _preferences) => {
        generateReplyCalls += 1;
        return generateReplyCalls === 1 ? firstReplyPending : ok(aConciergeReply("second reply"));
      },
    };

    const firstCall = respondToCallerMessage(
      { modelClient: slowModelClient, memory, sessionLock, toolExecutor },
      sessionId,
      actorId,
      aCallerMessage("first message"),
    );
    const secondCall = respondToCallerMessage(
      { modelClient: slowModelClient, memory, sessionLock, toolExecutor },
      sessionId,
      actorId,
      aCallerMessage("second message"),
    );
    resolveFirstReply(ok(aConciergeReply("first reply")));
    await Promise.all([firstCall, secondCall]);

    // Without serialization, the second call's generateReply resolves
    // immediately while the first is still pending, so its turn would be
    // recorded before the first's — order, not just count, proves the lock
    // actually serialized the two calls rather than letting them race.
    expect(memory.recordedTurns.map((recorded) => recorded.turn.message)).toEqual([
      "first message",
      "second message",
    ]);
  });
});

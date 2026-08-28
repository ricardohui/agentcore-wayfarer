import { beforeEach, describe, expect, it } from "vitest";
import { ok, err, type Result } from "../../../src/concierge/domain/result";
import { InMemoryConversationRepository } from "../../../src/concierge/adapter/in-memory-conversation-repository";
import { InMemorySessionLock } from "../../../src/concierge/adapter/in-memory-session-lock";
import { respondToCallerMessage } from "../../../src/concierge/usecase/respond-to-caller-message";
import type { ConciergeReply } from "../../../src/concierge/domain/concierge-reply";
import type { ModelClient, ModelError } from "../../../src/concierge/usecase/ports";
import { FakeModelClient } from "../support/fakes";
import { aCallerMessage, aConciergeReply, aRuntimeSessionId } from "../support/object-mothers";

describe("respondToCallerMessage", () => {
  let modelClient: FakeModelClient;
  let conversationRepository: InMemoryConversationRepository;
  let sessionLock: InMemorySessionLock;

  beforeEach(() => {
    modelClient = new FakeModelClient(ok(aConciergeReply()));
    conversationRepository = new InMemoryConversationRepository();
    sessionLock = new InMemorySessionLock();
  });

  it("returns the model's reply and records the turn", async () => {
    const sessionId = aRuntimeSessionId();
    const message = aCallerMessage("Plan me a trip to Tokyo");
    const reply = aConciergeReply("Let's start with your travel dates.");
    modelClient.respondWith(ok(reply));

    const result = await respondToCallerMessage(
      { modelClient, conversationRepository, sessionLock },
      sessionId,
      message,
    );

    expect(result).toEqual({ ok: true, value: reply });
    const conversation = conversationRepository.get(sessionId);
    expect(conversation?.turns).toEqual([{ message, reply }]);
  });

  it("gives the model client only the requesting session's transcript", async () => {
    const sessionA = aRuntimeSessionId("a");
    const sessionB = aRuntimeSessionId("b");
    await respondToCallerMessage(
      { modelClient, conversationRepository, sessionLock },
      sessionA,
      aCallerMessage("I only exist in session A"),
    );

    await respondToCallerMessage(
      { modelClient, conversationRepository, sessionLock },
      sessionB,
      aCallerMessage("What did I say before?"),
    );

    const transcriptSeenBySessionB = modelClient.receivedTranscripts[1];
    expect(transcriptSeenBySessionB).toEqual([]);
  });

  it("does not record a turn when the model client fails", async () => {
    const sessionId = aRuntimeSessionId();
    const modelError = { type: "ModelUnavailable" as const, message: "throttled" };
    modelClient.respondWith(err(modelError));

    const result = await respondToCallerMessage(
      { modelClient, conversationRepository, sessionLock },
      sessionId,
      aCallerMessage("Plan me a trip to Tokyo"),
    );

    expect(result).toEqual({ ok: false, error: modelError });
    expect(conversationRepository.get(sessionId)).toBeUndefined();
  });

  it("serializes two concurrent calls for the same session so neither turn is lost", async () => {
    const sessionId = aRuntimeSessionId();
    let resolveFirstReply!: (result: Result<ConciergeReply, ModelError>) => void;
    const firstReplyPending = new Promise<Result<ConciergeReply, ModelError>>((resolve) => {
      resolveFirstReply = resolve;
    });
    let generateReplyCalls = 0;
    const slowModelClient: ModelClient = {
      generateReply: async () => {
        generateReplyCalls += 1;
        return generateReplyCalls === 1 ? firstReplyPending : ok(aConciergeReply("second reply"));
      },
    };

    const firstCall = respondToCallerMessage(
      { modelClient: slowModelClient, conversationRepository, sessionLock },
      sessionId,
      aCallerMessage("first message"),
    );
    const secondCall = respondToCallerMessage(
      { modelClient: slowModelClient, conversationRepository, sessionLock },
      sessionId,
      aCallerMessage("second message"),
    );
    resolveFirstReply(ok(aConciergeReply("first reply")));
    await Promise.all([firstCall, secondCall]);

    const conversation = conversationRepository.get(sessionId);
    expect(conversation?.turns).toHaveLength(2);
  });
});

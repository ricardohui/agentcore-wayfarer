import type { ActorId } from "../domain/actor-id";
import type { CallerMessage } from "../domain/caller-message";
import type { ConciergeReply } from "../domain/concierge-reply";
import type { Result } from "../domain/result";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { MemoryPort, ModelClient, ModelError, SessionLock, ToolExecutor } from "./ports";

// A search-then-hold trip-planning session is a handful of turns, not a long
// chat history — this bounds what get_last_k_turns pulls back for the model.
const RECENT_TURNS_LIMIT = 20;

export type RespondToCallerMessagePorts = {
  readonly modelClient: ModelClient;
  readonly memory: MemoryPort;
  readonly sessionLock: SessionLock;
  readonly toolExecutor: ToolExecutor;
};

export async function respondToCallerMessage(
  ports: RespondToCallerMessagePorts,
  sessionId: RuntimeSessionId,
  actorId: ActorId,
  message: CallerMessage,
): Promise<Result<ConciergeReply, ModelError>> {
  return ports.sessionLock.runExclusive(sessionId, async () => {
    // Memory unavailability is a degraded-recall condition, not a reason to
    // refuse the Caller a reply — fall back to a fresh, preference-less turn.
    const recentTurnsResult = await ports.memory.getRecentTurns(sessionId, actorId, RECENT_TURNS_LIMIT);
    const transcript = recentTurnsResult.ok ? recentTurnsResult.value : [];

    const preferencesResult = await ports.memory.getPreferences(actorId);
    const preferences = preferencesResult.ok ? preferencesResult.value : [];

    const replyResult = await ports.modelClient.generateReply(
      transcript,
      message,
      ports.toolExecutor,
      preferences,
    );
    if (!replyResult.ok) {
      return replyResult;
    }

    await ports.memory.recordTurn(sessionId, actorId, { message, reply: replyResult.value });
    return replyResult;
  });
}

import type { CallerMessage } from "../domain/caller-message";
import type { ConciergeReply } from "../domain/concierge-reply";
import { PlanningConversation } from "../domain/planning-conversation";
import type { Result } from "../domain/result";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { ConversationRepository, ModelClient, ModelError, SessionLock, ToolExecutor } from "./ports";

export type RespondToCallerMessagePorts = {
  readonly modelClient: ModelClient;
  readonly conversationRepository: ConversationRepository;
  readonly sessionLock: SessionLock;
  readonly toolExecutor: ToolExecutor;
};

export async function respondToCallerMessage(
  ports: RespondToCallerMessagePorts,
  sessionId: RuntimeSessionId,
  message: CallerMessage,
): Promise<Result<ConciergeReply, ModelError>> {
  return ports.sessionLock.runExclusive(sessionId, async () => {
    const conversation =
      ports.conversationRepository.get(sessionId) ?? PlanningConversation.empty(sessionId);

    const replyResult = await ports.modelClient.generateReply(
      conversation.turns,
      message,
      ports.toolExecutor,
    );
    if (!replyResult.ok) {
      return replyResult;
    }

    ports.conversationRepository.save(conversation.record(message, replyResult.value));
    return replyResult;
  });
}

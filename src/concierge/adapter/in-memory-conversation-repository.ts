import type { PlanningConversation } from "../domain/planning-conversation";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { ConversationRepository } from "../usecase/ports";

/**
 * Session state lives only in this process's memory — Runtime's microVM-per-session
 * isolation is what keeps one Caller's conversation from another's, not this store.
 * A durable, cross-session store is Memory's job (a later primitive).
 */
export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversationsBySessionId = new Map<RuntimeSessionId, PlanningConversation>();

  get(sessionId: RuntimeSessionId): PlanningConversation | undefined {
    return this.conversationsBySessionId.get(sessionId);
  }

  save(conversation: PlanningConversation): void {
    this.conversationsBySessionId.set(conversation.sessionId, conversation);
  }
}

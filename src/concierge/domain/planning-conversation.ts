import type { CallerMessage } from "./caller-message";
import type { ConciergeReply } from "./concierge-reply";
import type { ConversationTurn } from "./conversation-turn";
import type { RuntimeSessionId } from "./runtime-session-id";

export class PlanningConversation {
  private constructor(
    public readonly sessionId: RuntimeSessionId,
    public readonly turns: readonly ConversationTurn[],
  ) {}

  static empty(sessionId: RuntimeSessionId): PlanningConversation {
    return new PlanningConversation(sessionId, []);
  }

  record(message: CallerMessage, reply: ConciergeReply): PlanningConversation {
    return new PlanningConversation(this.sessionId, [...this.turns, { message, reply }]);
  }
}

import type { CallerMessage } from "./caller-message";
import type { ConciergeReply } from "./concierge-reply";

export type ConversationTurn = {
  readonly message: CallerMessage;
  readonly reply: ConciergeReply;
};

import type { CallerMessage } from "../domain/caller-message";
import type { ConciergeReply } from "../domain/concierge-reply";
import type { ConversationTurn } from "../domain/conversation-turn";
import type { PlanningConversation } from "../domain/planning-conversation";
import type { Result } from "../domain/result";
import type { RuntimeSessionId } from "../domain/runtime-session-id";

export type ModelError =
  | { readonly type: "ModelUnavailable"; readonly message: string }
  | { readonly type: "InvalidResponse"; readonly message: string };

export interface ModelClient {
  generateReply(
    transcript: readonly ConversationTurn[],
    message: CallerMessage,
  ): Promise<Result<ConciergeReply, ModelError>>;
}

export interface ConversationRepository {
  get(sessionId: RuntimeSessionId): PlanningConversation | undefined;
  save(conversation: PlanningConversation): void;
}

export interface SessionLock {
  // Serializes read-modify-write access to one session's conversation, so two
  // overlapping invocations for the same runtimeSessionId can't race and drop
  // a turn (Runtime routes same-session calls to one microVM, but that VM's
  // event loop can still interleave two concurrent requests).
  runExclusive<TResult>(sessionId: RuntimeSessionId, fn: () => Promise<TResult>): Promise<TResult>;
}

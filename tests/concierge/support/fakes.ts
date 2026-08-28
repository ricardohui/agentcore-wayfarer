import type { CallerMessage } from "../../../src/concierge/domain/caller-message";
import type { ConciergeReply } from "../../../src/concierge/domain/concierge-reply";
import type { ConversationTurn } from "../../../src/concierge/domain/conversation-turn";
import type { Result } from "../../../src/concierge/domain/result";
import type { ModelClient, ModelError } from "../../../src/concierge/usecase/ports";

export class FakeModelClient implements ModelClient {
  public receivedTranscripts: (readonly ConversationTurn[])[] = [];
  private nextResult: Result<ConciergeReply, ModelError>;

  constructor(nextResult: Result<ConciergeReply, ModelError>) {
    this.nextResult = nextResult;
  }

  respondWith(result: Result<ConciergeReply, ModelError>): void {
    this.nextResult = result;
  }

  async generateReply(
    transcript: readonly ConversationTurn[],
    _message: CallerMessage,
  ): Promise<Result<ConciergeReply, ModelError>> {
    this.receivedTranscripts.push(transcript);
    return this.nextResult;
  }
}

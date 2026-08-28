import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { CallerMessage } from "../domain/caller-message";
import { parseConciergeReply, type ConciergeReply } from "../domain/concierge-reply";
import type { ConversationTurn } from "../domain/conversation-turn";
import { err, ok, type Result } from "../domain/result";
import type { ModelClient, ModelError } from "../usecase/ports";

const MAX_OUTPUT_TOKENS = 1024;

export class BedrockConverseModelClient implements ModelClient {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string,
  ) {}

  async generateReply(
    transcript: readonly ConversationTurn[],
    message: CallerMessage,
  ): Promise<Result<ConciergeReply, ModelError>> {
    try {
      const response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages: [...toBedrockMessages(transcript), toUserMessage(message)],
          inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS },
        }),
      );

      return toConciergeReply(response);
    } catch (error) {
      return err({
        type: "ModelUnavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toBedrockMessages(transcript: readonly ConversationTurn[]) {
  return transcript.flatMap((turn) => [
    { role: "user" as const, content: [{ text: turn.message }] },
    { role: "assistant" as const, content: [{ text: turn.reply }] },
  ]);
}

function toUserMessage(message: CallerMessage) {
  return { role: "user" as const, content: [{ text: message }] };
}

function toConciergeReply(
  response: ConverseCommandOutput,
): Result<ConciergeReply, ModelError> {
  // Reasoning models (e.g. gpt-oss) put a reasoningContent block ahead of the
  // text block, so the reply isn't always content[0].
  const text = response.output?.message?.content?.find(
    (block): block is { text: string } => typeof block.text === "string",
  )?.text;
  if (!text) {
    return err({ type: "InvalidResponse", message: "model returned no text content" });
  }

  const replyResult = parseConciergeReply(text);
  if (!replyResult.ok) {
    return err({ type: "InvalidResponse", message: replyResult.error.message });
  }

  return ok(replyResult.value);
}

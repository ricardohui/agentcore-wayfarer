import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { BOOKING_TOOL_DEFINITIONS } from "../../booking-gateway/tool-catalog";
import type { CallerMessage } from "../domain/caller-message";
import type { CallerPreference } from "../domain/caller-preference";
import { parseConciergeReply, type ConciergeReply } from "../domain/concierge-reply";
import type { ConversationTurn } from "../domain/conversation-turn";
import { err, ok, type Result } from "../domain/result";
import { CALENDAR_TOOL_DEFINITIONS } from "../usecase/calendar-tool-catalog";
import type { ModelClient, ModelError, ToolCall, ToolExecutor } from "../usecase/ports";

const MAX_OUTPUT_TOKENS = 1024;

// A search-then-hold-then-calendar-write trip-planning turn is at most a
// handful of tool calls (search-flights, hold-flight, search-hotels,
// hold-hotel, write-calendar-event — issue #17); this bounds a misbehaving
// model from looping forever instead of ever replying.
const MAX_TOOL_USE_ROUNDS = 8;

// The Concierge is the client-side tool-use loop (Harness's declarative
// `agentcore_gateway` tool is the alternative, comparison-build path per
// ADR-0002), so it declares this contract to the model itself, built from
// the same BOOKING_TOOL_DEFINITIONS Gateway's own target enforces, plus
// issue #17's Concierge-owned calendar-write tool (not a Gateway target).
const TOOL_CONFIG: ToolConfiguration = {
  tools: [...BOOKING_TOOL_DEFINITIONS, ...CALENDAR_TOOL_DEFINITIONS].map((definition) => ({
    toolSpec: {
      name: definition.name,
      description: definition.description,
      inputSchema: { json: definition.inputSchema as unknown as DocumentType },
    },
  })),
};

export class BedrockConverseModelClient implements ModelClient {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string,
  ) {}

  async generateReply(
    transcript: readonly ConversationTurn[],
    message: CallerMessage,
    toolExecutor: ToolExecutor,
    preferences: readonly CallerPreference[],
  ): Promise<Result<ConciergeReply, ModelError>> {
    const messages: Message[] = [...toBedrockMessages(transcript), toUserMessage(message)];
    const system = toSystemBlocks(preferences);

    try {
      for (let round = 0; round < MAX_TOOL_USE_ROUNDS; round += 1) {
        const response = await this.client.send(
          new ConverseCommand({
            modelId: this.modelId,
            messages,
            ...(system ? { system } : {}),
            toolConfig: TOOL_CONFIG,
            inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS },
          }),
        );

        const toolCalls = extractToolCalls(response);
        if (toolCalls.length === 0) {
          return toConciergeReply(response);
        }

        messages.push({ role: "assistant", content: response.output?.message?.content ?? [] });
        messages.push(await toToolResultMessage(toolCalls, toolExecutor));
      }

      return err({ type: "InvalidResponse", message: "model exceeded the maximum tool-use rounds" });
    } catch (error) {
      return err({
        type: "ModelUnavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toBedrockMessages(transcript: readonly ConversationTurn[]): Message[] {
  return transcript.flatMap((turn) => [
    { role: "user" as const, content: [{ text: turn.message }] },
    { role: "assistant" as const, content: [{ text: turn.reply }] },
  ]);
}

function toUserMessage(message: CallerMessage): Message {
  return { role: "user", content: [{ text: message }] };
}

function toSystemBlocks(preferences: readonly CallerPreference[]): SystemContentBlock[] | undefined {
  if (preferences.length === 0) {
    return undefined;
  }
  const facts = preferences.map((preference) => `- ${preference}`).join("\n");
  return [{ text: `What you already know about this returning Caller:\n${facts}` }];
}

function extractToolCalls(response: ConverseCommandOutput): ToolCall[] {
  const blocks = response.output?.message?.content ?? [];
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    const toolUse = block.toolUse;
    // Every toolUse block that reaches here gets echoed back verbatim into
    // `messages` below, so every toolUseId — even one with a missing/blank
    // name — must get a matching toolResult, or the next Converse call sees
    // an internally inconsistent conversation. An unnamed call still routes
    // through ToolExecutor, which reports it as an unknown tool.
    if (toolUse?.toolUseId) {
      toolCalls.push({ toolUseId: toolUse.toolUseId, name: toolUse.name ?? "", input: toolUse.input });
    }
  }
  return toolCalls;
}

async function toToolResultMessage(toolCalls: ToolCall[], toolExecutor: ToolExecutor): Promise<Message> {
  const results = await Promise.all(toolCalls.map((call) => toolExecutor.execute(call)));
  return {
    role: "user",
    content: results.map((result) => ({
      toolResult: {
        toolUseId: result.toolUseId,
        status: result.isError ? ("error" as const) : ("success" as const),
        content: [{ json: result.content as DocumentType }],
      },
    })),
  };
}

function toConciergeReply(response: ConverseCommandOutput): Result<ConciergeReply, ModelError> {
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

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
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
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import { CALENDAR_TOOL_DEFINITIONS } from "../usecase/calendar-tool-catalog";
import { KNOWLEDGE_BASE_TOOL_DEFINITIONS, type KnowledgeBaseToolName } from "../usecase/knowledge-base-tool-catalog";
import type { ModelClient, ModelError, ToolCall, ToolCallResult, ToolExecutor } from "../usecase/ports";
import { withSpan } from "../observability/tracing";

const MAX_OUTPUT_TOKENS = 1024;

// A search-then-hold-then-calendar-write trip-planning turn is at most a
// handful of tool calls (search-flights, hold-flight, search-hotels,
// hold-hotel, write-calendar-event — issue #17); this bounds a misbehaving
// model from looping forever instead of ever replying.
const MAX_TOOL_USE_ROUNDS = 8;

// The Concierge is the client-side tool-use loop (Harness's declarative
// `agentcore_gateway` tool is the alternative, comparison-build path per
// ADR-0002), so it declares this contract to the model itself, built from
// the same BOOKING_TOOL_DEFINITIONS Gateway's own target enforces, issue
// #17's Concierge-owned calendar-write tool (not a Gateway target), and
// issue #21's destination-guide retrieve tool (a second Gateway target).
const TOOL_CONFIG: ToolConfiguration = {
  tools: [...BOOKING_TOOL_DEFINITIONS, ...CALENDAR_TOOL_DEFINITIONS, ...KNOWLEDGE_BASE_TOOL_DEFINITIONS].map((definition) => ({
    toolSpec: {
      name: definition.name,
      description: definition.description,
      inputSchema: { json: definition.inputSchema as unknown as DocumentType },
    },
  })),
};

// The one tool result that carries genuinely external-sourced free text
// (issue #26 / ADR-0011) — every other tool result (booking, calendar) is
// either structured/strictly-typed JSON or, for Browser Tool's price-check,
// nested inside hold-flight/hold-hotel's own payload rather than exposed as
// an independently-addressable tool result, so only this one gets
// `guardContent`-wrapped for the Guardrail's contextual grounding check.
const GROUNDED_TOOL_NAME: KnowledgeBaseToolName = "retrieve-destination-guide";

export class BedrockConverseModelClient implements ModelClient {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string,
    // The Guardrail (issue #26 / ADR-0011): blanket protection on every
    // Caller turn. `trace: "disabled"` below keeps flagged (possibly
    // sensitive) text out of the API response and this Runtime's own logs.
    private readonly guardrailId: string,
    private readonly guardrailVersion: string,
  ) {}

  async generateReply(
    transcript: readonly ConversationTurn[],
    message: CallerMessage,
    toolExecutor: ToolExecutor,
    preferences: readonly CallerPreference[],
    sessionId: RuntimeSessionId,
  ): Promise<Result<ConciergeReply, ModelError>> {
    const messages: Message[] = [...toBedrockMessages(transcript), toUserMessage(message)];
    const system = toSystemBlocks(preferences);

    try {
      for (let round = 0; round < MAX_TOOL_USE_ROUNDS; round += 1) {
        // Inference span (issue #24 / ADR-0008): one per model round, not
        // per turn - a single Caller message can drive several rounds of
        // tool calls (MAX_TOOL_USE_ROUNDS), and each is its own model call.
        const response = await withSpan(
          `chat ${this.modelId}`,
          {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": this.modelId,
            "gen_ai.input.messages": JSON.stringify(messages),
            "session.id": sessionId,
          },
          async (span) => {
            const converseResponse = await this.client.send(
              new ConverseCommand({
                modelId: this.modelId,
                messages,
                system,
                toolConfig: TOOL_CONFIG,
                inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS },
                guardrailConfig: {
                  guardrailIdentifier: this.guardrailId,
                  guardrailVersion: this.guardrailVersion,
                  trace: "disabled",
                },
              }),
            );
            span.setAttribute("gen_ai.output.messages", JSON.stringify(converseResponse.output?.message ?? {}));
            if (converseResponse.usage?.inputTokens !== undefined) {
              span.setAttribute("gen_ai.usage.input_tokens", converseResponse.usage.inputTokens);
            }
            if (converseResponse.usage?.outputTokens !== undefined) {
              span.setAttribute("gen_ai.usage.output_tokens", converseResponse.usage.outputTokens);
            }
            return converseResponse;
          },
        );

        const toolCalls = extractToolCalls(response);
        if (toolCalls.length === 0) {
          return toConciergeReply(response);
        }

        messages.push({ role: "assistant", content: response.output?.message?.content ?? [] });
        messages.push(await toToolResultMessage(toolCalls, toolExecutor, sessionId));
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

// A tool result carrying an authorizationUrl (calendar's ConsentRequired,
// issue #17 / ADR-0003) is the model's only channel to the Caller — the
// Concierge Runtime response is plain reply text, with no side channel a UI
// could render a link from (src/concierge/infra/handler.ts). Left unsaid,
// the model tends to invent a nonexistent "click Allow in the interface"
// UX instead of quoting the real URL.
const BASE_PERSONA_PROMPT =
  "You are the Wayfarer Concierge, a travel-booking assistant. " +
  "When a tool result carries an authorizationUrl (a ConsentRequired calendar-access request), " +
  "always quote that URL verbatim in your reply as a markdown link so the Caller can click it — " +
  "never assume the interface renders it for you.";

function toSystemBlocks(preferences: readonly CallerPreference[]): SystemContentBlock[] {
  if (preferences.length === 0) {
    return [{ text: BASE_PERSONA_PROMPT }];
  }
  const facts = preferences.map((preference) => `- ${preference}`).join("\n");
  return [{ text: `${BASE_PERSONA_PROMPT}\n\nWhat you already know about this returning Caller:\n${facts}` }];
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

async function toToolResultMessage(
  toolCalls: ToolCall[],
  toolExecutor: ToolExecutor,
  sessionId: RuntimeSessionId,
): Promise<Message> {
  const results = await Promise.all(toolCalls.map((call) => toolExecutor.execute(call, sessionId)));
  return {
    role: "user",
    content: toolCalls.flatMap((call, index) => toToolResultContentBlocks(call, results[index]!)),
  };
}

// The guardContent-wrapping seam (issue #26 / ADR-0011): a pure branch, no
// AWS SDK involvement, kept separate from toToolResultMessage so it's
// unit-testable on its own. Every ContentBlock's own toolResult is left
// exactly as before (guardContent isn't a variant of ToolResultContentBlock
// — confirmed against the SDK's own types, matching the Converse API's
// documented behavior that toolResult content is never guardrail-evaluated
// regardless). A successful GROUNDED_TOOL_NAME result with real excerpt text
// and the model's actual query additionally gets two sibling guardContent
// blocks in the same message — contextual grounding needs both halves of
// the source/query pair to run at all (confirmed against AWS's own
// contextual-grounding-check docs); an errored result, or one with nothing
// to ground (no excerpts, or an unparseable query), is left as a plain
// toolResult, since there's no real content to check the model's eventual
// answer against.
export function toToolResultContentBlocks(call: ToolCall, result: ToolCallResult): ContentBlock[] {
  const toolResultBlock: ContentBlock = {
    toolResult: {
      toolUseId: result.toolUseId,
      status: result.isError ? ("error" as const) : ("success" as const),
      content: [{ json: result.content as DocumentType }],
    },
  };
  if (call.name !== GROUNDED_TOOL_NAME || result.isError) {
    return [toolResultBlock];
  }

  const groundingSourceText = toGroundingSourceText(result.content);
  const queryText = toQueryText(call.input);
  if (groundingSourceText.length === 0 || queryText.length === 0) {
    return [toolResultBlock];
  }

  return [
    toolResultBlock,
    { guardContent: { text: { text: groundingSourceText, qualifiers: ["grounding_source"] } } },
    { guardContent: { text: { text: queryText, qualifiers: ["query"] } } },
  ];
}

function toGroundingSourceText(content: unknown): string {
  const excerpts = (content as { excerpts?: unknown } | undefined)?.excerpts;
  if (!Array.isArray(excerpts)) {
    return "";
  }
  return excerpts
    .map((excerpt) => String((excerpt as { text?: unknown }).text ?? ""))
    .join("\n\n")
    .trim();
}

function toQueryText(input: unknown): string {
  const query = (input as { query?: unknown } | undefined)?.query;
  return typeof query === "string" ? query.trim() : "";
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

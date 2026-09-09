import type { DestinationGuideExcerpt } from "../domain/destination-guide-excerpt";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import { KNOWLEDGE_BASE_TOOL_DEFINITIONS, type KnowledgeBaseToolName } from "./knowledge-base-tool-catalog";
import type { KnowledgeBasePort, ToolCall, ToolCallResult, ToolExecutor } from "./ports";
import { toolError, toolSuccess } from "./tool-call-result";

export const KNOWLEDGE_BASE_TOOL_NAMES = KNOWLEDGE_BASE_TOOL_DEFINITIONS.map((definition) => definition.name);

function isKnowledgeBaseToolName(name: string): name is KnowledgeBaseToolName {
  return (KNOWLEDGE_BASE_TOOL_NAMES as readonly string[]).includes(name);
}

function serializeExcerpt(excerpt: DestinationGuideExcerpt) {
  return excerpt.toJSON();
}

// Dispatches the model's retrieve-destination-guide tool-use call to the
// Knowledge Base's Gateway target (issue #21 / ADR-0009). Unlike
// BookingToolExecutor, there's no candidate cache, price-check, or Policy
// consequence to bridge — read-only, ungated, one call in, one call out.
export class KnowledgeBaseToolExecutor implements ToolExecutor {
  constructor(private readonly knowledgeBase: KnowledgeBasePort) {}

  async execute(call: ToolCall, _sessionId: RuntimeSessionId): Promise<ToolCallResult> {
    if (!isKnowledgeBaseToolName(call.name)) {
      return toolError(call.toolUseId, `unknown tool: ${call.name}`);
    }

    const input = (call.input ?? {}) as Record<string, unknown>;
    const query = String(input.query ?? "");
    if (query.trim().length === 0) {
      return toolError(call.toolUseId, "query must not be blank");
    }

    const result = await this.knowledgeBase.retrieve(query);
    if (!result.ok) {
      return toolError(call.toolUseId, result.error.message);
    }
    return toolSuccess(call.toolUseId, { excerpts: result.value.map(serializeExcerpt) });
  }
}


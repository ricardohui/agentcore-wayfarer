// Single source of truth for the Concierge's own destination-guide tool
// (issue #21 / ADR-0009) — a Concierge-owned model-facing name/schema, not the
// Gateway connector's own wire contract (which the adapter alone speaks, see
// knowledge-base-gateway-adapter.ts). Imported by both
// BedrockConverseModelClient (the contract shown to the model) and
// KnowledgeBaseToolExecutor (the contract it dispatches), so the two can't
// drift.
export type KnowledgeBaseToolName = "retrieve-destination-guide";

export type KnowledgeBaseToolDefinition = {
  readonly name: KnowledgeBaseToolName;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, { readonly type: string; readonly description?: string }>;
    readonly required: readonly string[];
  };
};

export const KNOWLEDGE_BASE_TOOL_DEFINITIONS: readonly KnowledgeBaseToolDefinition[] = [
  {
    name: "retrieve-destination-guide",
    description:
      "Retrieve destination-guide content (visa/entry requirements, climate, customs, packing advice) for " +
      "one of Wayfarer's 3 scenario cities. Call this whenever the Caller asks a destination-related " +
      "question, so the answer is grounded in the guide rather than the model's own unaided knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The Caller's destination-related question, e.g. \"what's the visa situation for Tokyo?\"",
        },
      },
      required: ["query"],
    },
  },
];

import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { mockClient } from "aws-sdk-client-mock";

export const KNOWLEDGE_BASE_ID = "test-knowledge-base-id";

// Shared network-boundary interception for every adapter/acceptance test that
// exercises the real BedrockKnowledgeBaseAdapter — one harness, not one per file.
export const knowledgeBaseMock = mockClient(BedrockAgentRuntimeClient);

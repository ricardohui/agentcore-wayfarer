import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { mockClient } from "aws-sdk-client-mock";

export const MEMORY_ID = "test-memory-id";

// Shared network-boundary interception for every adapter/acceptance test that
// exercises the real AgentCoreMemoryAdapter — one harness, not one per file.
export const memoryMock = mockClient(BedrockAgentCoreClient);

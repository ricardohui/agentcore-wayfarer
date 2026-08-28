import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockConverseModelClient } from "../adapter/bedrock-converse-model-client";
import { InMemoryConversationRepository } from "../adapter/in-memory-conversation-repository";
import { InMemorySessionLock } from "../adapter/in-memory-session-lock";
import type { RespondToCallerMessagePorts } from "../usecase/respond-to-caller-message";
import { CONCIERGE_MODEL_ID } from "./model-id";

const DEFAULT_REGION = "us-east-1";

export function buildConciergePorts(): RespondToCallerMessagePorts {
  const region = process.env.AWS_REGION ?? DEFAULT_REGION;
  const modelId = process.env.CONCIERGE_MODEL_ID ?? CONCIERGE_MODEL_ID;

  return {
    modelClient: new BedrockConverseModelClient(new BedrockRuntimeClient({ region }), modelId),
    conversationRepository: new InMemoryConversationRepository(),
    sessionLock: new InMemorySessionLock(),
  };
}

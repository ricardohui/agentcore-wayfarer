import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockConverseModelClient } from "../adapter/bedrock-converse-model-client";
import { BookingGatewayAdapter } from "../adapter/booking-gateway-adapter";
import { InMemoryConversationRepository } from "../adapter/in-memory-conversation-repository";
import { InMemorySessionLock } from "../adapter/in-memory-session-lock";
import { createSigV4Fetch } from "../adapter/sigv4-fetch";
import { BookingToolExecutor } from "../usecase/booking-tool-executor";
import type { RespondToCallerMessagePorts } from "../usecase/respond-to-caller-message";
import { CONCIERGE_MODEL_ID } from "./model-id";

const DEFAULT_REGION = "us-east-1";
const GATEWAY_SIGNING_SERVICE = "bedrock-agentcore";

export function buildConciergePorts(): RespondToCallerMessagePorts {
  const region = process.env.AWS_REGION ?? DEFAULT_REGION;
  const modelId = process.env.CONCIERGE_MODEL_ID ?? CONCIERGE_MODEL_ID;
  const gatewayUrl = requireEnv("GATEWAY_URL");

  const bookingGateway = new BookingGatewayAdapter(
    gatewayUrl,
    createSigV4Fetch(region, GATEWAY_SIGNING_SERVICE),
  );

  return {
    modelClient: new BedrockConverseModelClient(new BedrockRuntimeClient({ region }), modelId),
    conversationRepository: new InMemoryConversationRepository(),
    sessionLock: new InMemorySessionLock(),
    toolExecutor: new BookingToolExecutor(bookingGateway),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { AgentCoreMemoryAdapter } from "../adapter/agentcore-memory-adapter";
import { BedrockConverseModelClient } from "../adapter/bedrock-converse-model-client";
import { CodeInterpreterBudgetAdapter } from "../adapter/code-interpreter-budget-adapter";
import { CognitoJwtVerifier } from "../adapter/cognito-jwt-verifier";
import { BookingGatewayAdapter } from "../adapter/booking-gateway-adapter";
import { DelegatedCalendarAdapter } from "../adapter/delegated-calendar-adapter";
import { InMemorySessionLock } from "../adapter/in-memory-session-lock";
import { createSigV4Fetch } from "../adapter/sigv4-fetch";
import { BOOKING_TOOL_NAMES, BookingToolExecutor } from "../usecase/booking-tool-executor";
import { CALENDAR_TOOL_NAMES, CalendarToolExecutor } from "../usecase/calendar-tool-executor";
import { CompositeToolExecutor } from "../usecase/composite-tool-executor";
import type { JwtVerifierPort } from "../usecase/ports";
import type { RespondToCallerMessagePorts } from "../usecase/respond-to-caller-message";
import { CONCIERGE_MODEL_ID } from "./model-id";

const DEFAULT_REGION = "us-east-1";
const GATEWAY_SIGNING_SERVICE = "bedrock-agentcore";

export function buildConciergePorts(): RespondToCallerMessagePorts {
  const region = process.env.AWS_REGION ?? DEFAULT_REGION;
  const modelId = process.env.CONCIERGE_MODEL_ID ?? CONCIERGE_MODEL_ID;
  const gatewayUrl = requireEnv("GATEWAY_URL");
  const memoryId = requireEnv("MEMORY_ID");
  const calendarCredentialProviderName = requireEnv("CALENDAR_CREDENTIAL_PROVIDER_NAME");
  const calendarApiUrl = requireEnv("CALENDAR_API_URL");
  const codeInterpreterId = requireEnv("CODE_INTERPRETER_ID");

  const bookingGateway = new BookingGatewayAdapter(
    gatewayUrl,
    createSigV4Fetch(region, GATEWAY_SIGNING_SERVICE),
  );
  const identityClient = new BedrockAgentCoreClient({ region });
  const calendar = new DelegatedCalendarAdapter(identityClient, calendarCredentialProviderName, calendarApiUrl);
  const budget = new CodeInterpreterBudgetAdapter(identityClient, codeInterpreterId);

  return {
    modelClient: new BedrockConverseModelClient(new BedrockRuntimeClient({ region }), modelId),
    memory: new AgentCoreMemoryAdapter(identityClient, memoryId),
    sessionLock: new InMemorySessionLock(),
    toolExecutor: new CompositeToolExecutor([
      { toolNames: BOOKING_TOOL_NAMES, executor: new BookingToolExecutor(bookingGateway, budget) },
      { toolNames: CALENDAR_TOOL_NAMES, executor: new CalendarToolExecutor(calendar) },
    ]),
  };
}

// Inbound auth (issue #17): built separately from buildConciergePorts()
// since it's consulted by infra/handler.ts ahead of respondToCallerMessage,
// not by the usecase itself.
export function buildJwtVerifier(): JwtVerifierPort {
  const issuer = requireEnv("COGNITO_ISSUER");
  const audience = requireEnv("COGNITO_CLIENT_ID");
  return new CognitoJwtVerifier(issuer, audience);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

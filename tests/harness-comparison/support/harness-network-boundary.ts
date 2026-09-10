import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { mockClient } from "aws-sdk-client-mock";

export const TEST_HARNESS_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/wayfarer_search_hold_comparison";

// Shared network-boundary interception for every test that exercises
// invokeSearchAndHoldBeat — this comparison build's only outward call.
export const harnessMock = mockClient(BedrockAgentCoreClient);

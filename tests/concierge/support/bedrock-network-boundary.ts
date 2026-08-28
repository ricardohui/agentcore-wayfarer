import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";

// Shared network-boundary interception for every adapter/acceptance test that
// exercises the real BedrockConverseModelClient — one harness, not one per file.
export const bedrockMock = mockClient(BedrockRuntimeClient);

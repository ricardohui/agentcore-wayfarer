import { InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { BedrockAgentCoreClient, InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";

export type InvokeSearchAndHoldBeatParams = {
  readonly client: BedrockAgentCoreClient;
  readonly harnessArn: string;
  readonly sessionId: string;
  readonly callerMessage: string;
  // Per-invocation model override (issue #22's acceptance criterion 2):
  // when set, this call alone runs against a different model — the Harness
  // resource itself is never redeployed or reconfigured.
  readonly modelIdOverride?: string;
};

export type SearchAndHoldBeatResult = {
  // Every assistant text delta emitted during the turn, concatenated in
  // order — not just a trailing summary line. For this beat's system prompt
  // (system-prompt.ts), the model's only text output is its closing
  // confirmation, so this is that confirmation in practice.
  readonly assistantText: string;
  readonly toolCallsObserved: readonly string[];
};

// The comparison build's only piece of code (ADR-0002, issue #22): submit
// one InvokeHarness call and decode its event stream. Tool execution against
// the booking Gateway happens entirely on AWS's side (the Harness's
// agentcore_gateway tool config) — there is no client-side tool loop to
// write, unlike the Concierge's own BedrockConverseModelClient.
export async function invokeSearchAndHoldBeat(params: InvokeSearchAndHoldBeatParams): Promise<SearchAndHoldBeatResult> {
  const command = new InvokeHarnessCommand({
    harnessArn: params.harnessArn,
    runtimeSessionId: params.sessionId,
    messages: [{ role: "user", content: [{ text: params.callerMessage }] }],
    ...(params.modelIdOverride
      ? { model: { bedrockModelConfig: { modelId: params.modelIdOverride } } }
      : {}),
  });

  const response = await params.client.send(command);
  return consumeStream(response.stream);
}

async function consumeStream(
  stream: AsyncIterable<InvokeHarnessStreamOutput> | undefined,
): Promise<SearchAndHoldBeatResult> {
  const toolCallsObserved: string[] = [];
  let assistantText = "";

  if (!stream) {
    return { assistantText, toolCallsObserved };
  }

  for await (const event of stream) {
    const toolUseStart = event.contentBlockStart?.start?.toolUse;
    if (toolUseStart?.name) {
      toolCallsObserved.push(toolUseStart.name);
    }

    const textDelta = event.contentBlockDelta?.delta?.text;
    if (textDelta) {
      assistantText += textDelta;
    }

    if (event.internalServerException) {
      throw new Error(event.internalServerException.message ?? "Harness invocation failed with an internal server error");
    }
    if (event.validationException) {
      throw new Error(event.validationException.message);
    }
    if (event.runtimeClientError) {
      throw new Error(event.runtimeClientError.message ?? "Harness invocation failed with a runtime client error");
    }
  }

  return { assistantText, toolCallsObserved };
}

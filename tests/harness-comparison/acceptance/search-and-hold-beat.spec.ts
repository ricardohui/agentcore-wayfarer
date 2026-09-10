import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { beforeEach, describe, expect, it } from "vitest";
import { invokeSearchAndHoldBeat } from "../../../src/harness-comparison/invoke-search-and-hold-beat";
import { HARNESS_DEFAULT_MODEL_ID, HARNESS_OVERRIDE_MODEL_ID } from "../../../src/harness-comparison/model-id";
import { harnessMock, TEST_HARNESS_ARN } from "../support/harness-network-boundary";
import { harnessStream } from "../support/harness-stream";

// Comparison build acceptance test (issue #22, acceptance criteria 1 and 4):
// this reimplements the same 3-city search+hold beat as Gateway's own
// booking-search-and-hold.spec.ts, but driven through InvokeHarness directly
// rather than the Concierge's Runtime entry point — the network boundary
// mocked here is the BedrockAgentCoreClient itself, since Harness's
// agentcore_gateway tool executes against the booking Gateway entirely on
// AWS's side (no client-observable HTTP call this test could intercept).
describe("Harness comparison build - search+hold beat (REQ-HARNESS-001, REQ-HARNESS-002)", () => {
  let client: BedrockAgentCoreClient;

  beforeEach(() => {
    harnessMock.reset();
    client = new BedrockAgentCoreClient({});
  });

  it("completes the search-then-hold beat for a 3-city trip request, invoked directly via InvokeHarness", async () => {
    harnessMock.on(InvokeHarnessCommand).resolves({
      stream: harnessStream(
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "call-1", name: "booking___search-flights" } },
          },
        },
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: { toolUse: { toolUseId: "call-2", name: "booking___hold-flight" } },
          },
        },
        {
          contentBlockStart: {
            contentBlockIndex: 2,
            start: { toolUse: { toolUseId: "call-3", name: "booking___search-hotels" } },
          },
        },
        {
          contentBlockStart: {
            contentBlockIndex: 3,
            start: { toolUse: { toolUseId: "call-4", name: "booking___hold-hotel" } },
          },
        },
        {
          contentBlockStart: { contentBlockIndex: 4, start: { toolUse: { toolUseId: "call-5", name: "final" } } },
        },
        { contentBlockDelta: { contentBlockIndex: 4, delta: { text: "Your Tokyo flight and hotel are both held!" } } },
        { messageStop: { stopReason: "end_turn" } },
      ),
    });

    const result = await invokeSearchAndHoldBeat({
      client,
      harnessArn: TEST_HARNESS_ARN,
      sessionId: "harness-comparison-session",
      callerMessage: "Plan me a trip to Tokyo and hold a flight and a hotel",
    });

    expect(result.toolCallsObserved).toEqual([
      "booking___search-flights",
      "booking___hold-flight",
      "booking___search-hotels",
      "booking___hold-hotel",
      "final",
    ]);
    expect(result.assistantText).toBe("Your Tokyo flight and hotel are both held!");
  });

  it("serves a per-invocation model override with no redeploy of the Harness resource", async () => {
    harnessMock.on(InvokeHarnessCommand).resolves({
      stream: harnessStream({ messageStop: { stopReason: "end_turn" } }),
    });

    await invokeSearchAndHoldBeat({
      client,
      harnessArn: TEST_HARNESS_ARN,
      sessionId: "harness-comparison-session",
      callerMessage: "Plan me a trip to Paris",
    });
    await invokeSearchAndHoldBeat({
      client,
      harnessArn: TEST_HARNESS_ARN,
      sessionId: "harness-comparison-session",
      callerMessage: "Now plan me a trip to New York",
      modelIdOverride: HARNESS_OVERRIDE_MODEL_ID,
    });

    const [defaultCall, overrideCall] = harnessMock.commandCalls(InvokeHarnessCommand);
    // Both calls target the same, already-provisioned Harness resource — the
    // override changes only the model field of the second InvokeHarness
    // call, not the Harness's own harnessArn or any CreateHarness/UpdateHarness call.
    expect(defaultCall?.args[0].input.harnessArn).toBe(TEST_HARNESS_ARN);
    expect(overrideCall?.args[0].input.harnessArn).toBe(TEST_HARNESS_ARN);
    expect(defaultCall?.args[0].input.model).toBeUndefined();
    expect(overrideCall?.args[0].input.model).toEqual({ bedrockModelConfig: { modelId: HARNESS_OVERRIDE_MODEL_ID } });
    expect(HARNESS_OVERRIDE_MODEL_ID).not.toBe(HARNESS_DEFAULT_MODEL_ID);
  });
});

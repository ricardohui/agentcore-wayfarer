import {
  BedrockAgentCoreClient,
  InternalServerException,
  InvokeHarnessCommand,
  ValidationException,
} from "@aws-sdk/client-bedrock-agentcore";
import { beforeEach, describe, expect, it } from "vitest";
import { invokeSearchAndHoldBeat } from "../../src/harness-comparison/invoke-search-and-hold-beat";
import { HARNESS_OVERRIDE_MODEL_ID } from "../../src/harness-comparison/model-id";
import { harnessMock, TEST_HARNESS_ARN } from "./support/harness-network-boundary";
import { harnessStream } from "./support/harness-stream";

describe("invokeSearchAndHoldBeat", () => {
  let client: BedrockAgentCoreClient;

  beforeEach(() => {
    harnessMock.reset();
    client = new BedrockAgentCoreClient({});
  });

  it("assembles the assistant's final text from contentBlockDelta text events", async () => {
    harnessMock.on(InvokeHarnessCommand).resolves({
      stream: harnessStream(
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Your Tokyo " } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "flight and hotel are held!" } } },
        { messageStop: { stopReason: "end_turn" } },
      ),
    });

    const result = await invokeSearchAndHoldBeat({
      client,
      harnessArn: TEST_HARNESS_ARN,
      sessionId: "session-1",
      callerMessage: "Plan me a trip to Tokyo and hold a flight and a hotel",
    });

    expect(result.assistantText).toBe("Your Tokyo flight and hotel are held!");
  });

  it("collects every tool name the Harness reports starting a toolUse content block for", async () => {
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
            contentBlockIndex: 2,
            start: { toolUse: { toolUseId: "call-2", name: "booking___hold-flight" } },
          },
        },
        { messageStop: { stopReason: "end_turn" } },
      ),
    });

    const result = await invokeSearchAndHoldBeat({
      client,
      harnessArn: TEST_HARNESS_ARN,
      sessionId: "session-1",
      callerMessage: "Plan me a trip to Tokyo",
    });

    expect(result.toolCallsObserved).toEqual(["booking___search-flights", "booking___hold-flight"]);
  });

  it("throws when the stream reports a validationException", async () => {
    harnessMock.on(InvokeHarnessCommand).resolves({
      stream: harnessStream({
        validationException: new ValidationException({
          message: "runtimeSessionId is required",
          reason: "FieldValidationFailed",
          $metadata: {},
        }),
      }),
    });

    await expect(
      invokeSearchAndHoldBeat({
        client,
        harnessArn: TEST_HARNESS_ARN,
        sessionId: "session-1",
        callerMessage: "Plan me a trip to Tokyo",
      }),
    ).rejects.toThrow("runtimeSessionId is required");
  });

  it("throws when the stream reports an internalServerException", async () => {
    harnessMock.on(InvokeHarnessCommand).resolves({
      stream: harnessStream({
        internalServerException: new InternalServerException({ message: "unexpected error", $metadata: {} }),
      }),
    });

    await expect(
      invokeSearchAndHoldBeat({
        client,
        harnessArn: TEST_HARNESS_ARN,
        sessionId: "session-1",
        callerMessage: "Plan me a trip to Tokyo",
      }),
    ).rejects.toThrow("unexpected error");
  });

  it("sends no model override by default, letting the Harness's stored declarative config decide", async () => {
    harnessMock.on(InvokeHarnessCommand).resolves({ stream: harnessStream({ messageStop: { stopReason: "end_turn" } }) });

    await invokeSearchAndHoldBeat({
      client,
      harnessArn: TEST_HARNESS_ARN,
      sessionId: "session-1",
      callerMessage: "Plan me a trip to Tokyo",
    });

    const [call] = harnessMock.commandCalls(InvokeHarnessCommand);
    expect(call?.args[0].input.model).toBeUndefined();
  });

  it("carries a per-invocation modelIdOverride straight through to the InvokeHarness call", async () => {
    harnessMock.on(InvokeHarnessCommand).resolves({ stream: harnessStream({ messageStop: { stopReason: "end_turn" } }) });

    await invokeSearchAndHoldBeat({
      client,
      harnessArn: TEST_HARNESS_ARN,
      sessionId: "session-1",
      callerMessage: "Plan me a trip to Tokyo",
      modelIdOverride: HARNESS_OVERRIDE_MODEL_ID,
    });

    const [call] = harnessMock.commandCalls(InvokeHarnessCommand);
    expect(call?.args[0].input.model).toEqual({ bedrockModelConfig: { modelId: HARNESS_OVERRIDE_MODEL_ID } });
    expect(call?.args[0].input.harnessArn).toBe(TEST_HARNESS_ARN);
  });
});

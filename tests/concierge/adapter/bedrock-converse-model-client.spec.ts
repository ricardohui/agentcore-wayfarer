import { BedrockRuntimeClient, ConverseCommand, ThrottlingException } from "@aws-sdk/client-bedrock-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { BedrockConverseModelClient } from "../../../src/concierge/adapter/bedrock-converse-model-client";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { aCallerMessage } from "../support/object-mothers";

const modelId = "openai.gpt-oss-120b-1:0";

describe("BedrockConverseModelClient", () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  it("extracts the reply text from a successful Converse response", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Hello traveler!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hi"));

    expect(result).toEqual({ ok: true, value: "Hello traveler!" });
  });

  it("always sets maxTokens explicitly, to avoid the default-max quota reservation", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Hello traveler!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    await client.generateReply([], aCallerMessage("Hi"));

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.inferenceConfig?.maxTokens).toBeTypeOf("number");
  });

  it("translates a throttling error into a typed ModelUnavailable error", async () => {
    bedrockMock.on(ConverseCommand).rejects(
      new ThrottlingException({ message: "too many requests", $metadata: {} }),
    );
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hi"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.type).toBe("ModelUnavailable");
  });

  it("skips a leading reasoningContent block to find the reply text", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: "assistant",
          content: [
            { reasoningContent: { reasoningText: { text: "thinking about it..." } } },
            { text: "Hello traveler!" },
          ],
        },
      },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hi"));

    expect(result).toEqual({ ok: true, value: "Hello traveler!" });
  });

  it("translates an empty response into a typed InvalidResponse error", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hi"));

    expect(result).toEqual({
      ok: false,
      error: { type: "InvalidResponse", message: "model returned no text content" },
    });
  });
});

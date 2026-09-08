import { BedrockRuntimeClient, ConverseCommand, ThrottlingException } from "@aws-sdk/client-bedrock-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { BedrockConverseModelClient } from "../../../src/concierge/adapter/bedrock-converse-model-client";
import { bedrockMock } from "../support/bedrock-network-boundary";
import { FakeToolExecutor } from "../support/fakes";
import { aCallerMessage, aCallerPreference, aRuntimeSessionId } from "../support/object-mothers";

const modelId = "openai.gpt-oss-120b-1:0";

describe("BedrockConverseModelClient", () => {
  let toolExecutor: FakeToolExecutor;

  beforeEach(() => {
    bedrockMock.reset();
    toolExecutor = new FakeToolExecutor();
  });

  it("extracts the reply text from a successful Converse response", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Hello traveler!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({ ok: true, value: "Hello traveler!" });
  });

  it("folds the actor's stored preferences into a system prompt", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Welcome back!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [aCallerPreference("home airport: NRT")], aRuntimeSessionId());

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input.system).toEqual([{ text: expect.stringContaining("home airport: NRT") }]);
  });

  it("still sends the base persona system prompt when there are no stored preferences", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Hello traveler!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input.system).toEqual([{ text: expect.stringContaining("authorizationUrl") }]);
  });

  it("instructs the model to always quote a ConsentRequired authorizationUrl verbatim as a link", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Hello traveler!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

    const calls = bedrockMock.commandCalls(ConverseCommand);
    const systemText = (calls[0]?.args[0].input.system as { text: string }[] | undefined)?.[0]?.text ?? "";
    expect(systemText).toMatch(/never assume the interface renders it/i);
  });

  it("always sets maxTokens explicitly, to avoid the default-max quota reservation", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Hello traveler!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.inferenceConfig?.maxTokens).toBeTypeOf("number");
  });

  it("advertises the 4 booking tools in every Converse call", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "Hello traveler!" }] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

    const calls = bedrockMock.commandCalls(ConverseCommand);
    const toolNames = calls[0]?.args[0].input.toolConfig?.tools?.map((tool) => tool.toolSpec?.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["search-flights", "search-hotels", "hold-flight", "hold-hotel"]),
    );
  });

  it("translates a throttling error into a typed ModelUnavailable error", async () => {
    bedrockMock.on(ConverseCommand).rejects(
      new ThrottlingException({ message: "too many requests", $metadata: {} }),
    );
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

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

    const result = await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({ ok: true, value: "Hello traveler!" });
  });

  it("translates an empty response into a typed InvalidResponse error", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [] } },
    });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hi"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({
      ok: false,
      error: { type: "InvalidResponse", message: "model returned no text content" },
    });
  });

  it("executes a tool-use call, sends the result back, and returns the model's final reply", async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce({
        output: {
          message: {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } } }],
          },
        },
        stopReason: "tool_use",
      })
      .resolvesOnce({
        output: { message: { role: "assistant", content: [{ text: "Found a flight for you!" }] } },
      });
    toolExecutor.respondTo("call-1", { isError: false, content: [{ candidateId: "flight-1" }] });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Find me a flight to Tokyo"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({ ok: true, value: "Found a flight for you!" });
    expect(toolExecutor.receivedCalls).toEqual([
      { toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } },
    ]);
    const secondCallMessages = bedrockMock.commandCalls(ConverseCommand)[1]?.args[0].input.messages ?? [];
    expect(secondCallMessages[secondCallMessages.length - 1]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "call-1",
            status: "success",
            content: [{ json: [{ candidateId: "flight-1" }] }],
          },
        },
      ],
    });
  });

  it("executes every tool-use block in a round before replying to the model", async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce({
        output: {
          message: {
            role: "assistant",
            content: [
              { toolUse: { toolUseId: "call-1", name: "search-flights", input: { destination: "TOKYO" } } },
              { toolUse: { toolUseId: "call-2", name: "search-hotels", input: { city: "TOKYO" } } },
            ],
          },
        },
        stopReason: "tool_use",
      })
      .resolvesOnce({
        output: { message: { role: "assistant", content: [{ text: "Here are your options." }] } },
      });
    toolExecutor.respondTo("call-1", { isError: false, content: [{ candidateId: "flight-1" }] });
    toolExecutor.respondTo("call-2", { isError: false, content: [{ candidateId: "hotel-1" }] });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Plan my trip"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({ ok: true, value: "Here are your options." });
    expect(toolExecutor.receivedCalls.map((call) => call.toolUseId)).toEqual(["call-1", "call-2"]);
  });

  it("surfaces a tool error result to the model as an error toolResult, not a thrown exception", async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce({
        output: {
          message: {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "call-1", name: "hold-flight", input: { candidateId: "bad" } } }],
          },
        },
        stopReason: "tool_use",
      })
      .resolvesOnce({
        output: { message: { role: "assistant", content: [{ text: "That candidate is no longer available." }] } },
      });
    toolExecutor.respondTo("call-1", { isError: true, content: { error: "candidate not found" } });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Hold that flight"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({ ok: true, value: "That candidate is no longer available." });
    const secondCallMessages = bedrockMock.commandCalls(ConverseCommand)[1]?.args[0].input.messages ?? [];
    expect(secondCallMessages[secondCallMessages.length - 1]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "call-1",
            status: "error",
            content: [{ json: { error: "candidate not found" } }],
          },
        },
      ],
    });
  });

  it("still calls the tool executor for a toolUse block with a missing name, so every toolUseId gets a matching toolResult", async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce({
        output: {
          message: { role: "assistant", content: [{ toolUse: { toolUseId: "call-1", name: undefined, input: {} } }] },
        },
        stopReason: "tool_use",
      })
      .resolvesOnce({
        output: { message: { role: "assistant", content: [{ text: "Handled." }] } },
      });
    toolExecutor.respondTo("call-1", { isError: true, content: { error: "unknown tool: " } });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Do something"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({ ok: true, value: "Handled." });
    expect(toolExecutor.receivedCalls).toEqual([{ toolUseId: "call-1", name: "", input: {} }]);
  });

  it("gives up after too many tool-use rounds and returns a typed InvalidResponse error", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "call-loop", name: "search-flights", input: { destination: "TOKYO" } } }],
        },
      },
      stopReason: "tool_use",
    });
    toolExecutor.respondTo("call-loop", { isError: false, content: [] });
    const client = new BedrockConverseModelClient(new BedrockRuntimeClient({}), modelId);

    const result = await client.generateReply([], aCallerMessage("Loop forever"), toolExecutor, [], aRuntimeSessionId());

    expect(result).toEqual({
      ok: false,
      error: { type: "InvalidResponse", message: "model exceeded the maximum tool-use rounds" },
    });
  });
});

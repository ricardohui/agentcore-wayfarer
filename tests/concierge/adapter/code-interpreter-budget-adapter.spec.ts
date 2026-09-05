import {
  BedrockAgentCoreClient,
  InvokeCodeInterpreterCommand,
  StartCodeInterpreterSessionCommand,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-bedrock-agentcore";
import { beforeEach, describe, expect, it } from "vitest";
import { CodeInterpreterBudgetAdapter } from "../../../src/concierge/adapter/code-interpreter-budget-adapter";
import { codeInterpreterStream } from "../support/code-interpreter-stream";
import { memoryMock } from "../support/memory-network-boundary";
import { aLocalPrice, aRuntimeSessionId } from "../support/object-mothers";

const CODE_INTERPRETER_ID = "test-code-interpreter-id";

describe("CodeInterpreterBudgetAdapter", () => {
  let adapter: CodeInterpreterBudgetAdapter;

  beforeEach(() => {
    memoryMock.reset();
    adapter = new CodeInterpreterBudgetAdapter(new BedrockAgentCoreClient({}), CODE_INTERPRETER_ID);
  });

  function stdoutResult(payload: unknown) {
    return {
      stream: codeInterpreterStream({
        result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
      }),
    };
  }

  it("starts a sandbox session once and reuses it across multiple holds in the same runtime session", async () => {
    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock
      .on(InvokeCodeInterpreterCommand)
      .resolves(stdoutResult({ runningTotal: 100, breakdownByCity: {}, breakdownByCategory: {} }));
    const sessionId = aRuntimeSessionId();

    await adapter.recordHold(sessionId, "TOKYO", "FLIGHT", aLocalPrice());
    await adapter.recordHold(sessionId, "TOKYO", "HOTEL", aLocalPrice());

    expect(memoryMock.commandCalls(StartCodeInterpreterSessionCommand)).toHaveLength(1);
    const invokeCalls = memoryMock.commandCalls(InvokeCodeInterpreterCommand);
    expect(invokeCalls).toHaveLength(2);
    for (const call of invokeCalls) {
      expect(call.args[0].input).toMatchObject({
        codeInterpreterIdentifier: CODE_INTERPRETER_ID,
        sessionId: "sandbox-1",
        name: "executeCode",
        arguments: expect.objectContaining({ language: "python", clearContext: false }),
      });
    }
  });

  it("starts only one sandbox session when two holds for the same runtime session race concurrently", async () => {
    // BedrockConverseModelClient runs a round's tool calls via Promise.all
    // (bedrock-converse-model-client.ts), so hold-flight and hold-hotel can
    // both call recordHold before either has cached a sandbox session.
    let resolveStart!: (value: { sessionId: string; createdAt: Date }) => void;
    memoryMock.on(StartCodeInterpreterSessionCommand).callsFake(
      () => new Promise((resolve) => { resolveStart = resolve; }),
    );
    memoryMock
      .on(InvokeCodeInterpreterCommand)
      .resolves(stdoutResult({ runningTotal: 100, breakdownByCity: {}, breakdownByCategory: {} }));
    const sessionId = aRuntimeSessionId();

    const both = Promise.all([
      adapter.recordHold(sessionId, "TOKYO", "FLIGHT", aLocalPrice()),
      adapter.recordHold(sessionId, "TOKYO", "HOTEL", aLocalPrice()),
    ]);
    resolveStart({ sessionId: "sandbox-1", createdAt: new Date() });
    await both;

    expect(memoryMock.commandCalls(StartCodeInterpreterSessionCommand)).toHaveLength(1);
  });

  it("retries starting a sandbox session after a failed start, instead of caching the rejection", async () => {
    memoryMock
      .on(StartCodeInterpreterSessionCommand)
      .rejectsOnce(new Error("throttled"))
      .resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock
      .on(InvokeCodeInterpreterCommand)
      .resolves(stdoutResult({ runningTotal: 100, breakdownByCity: {}, breakdownByCategory: {} }));
    const sessionId = aRuntimeSessionId();

    const first = await adapter.recordHold(sessionId, "TOKYO", "FLIGHT", aLocalPrice());
    const second = await adapter.recordHold(sessionId, "TOKYO", "FLIGHT", aLocalPrice());

    expect(first).toEqual({ ok: false, error: expect.objectContaining({ type: "SandboxUnavailable" }) });
    expect(second.ok).toBe(true);
    expect(memoryMock.commandCalls(StartCodeInterpreterSessionCommand)).toHaveLength(2);
  });

  it("starts a fresh sandbox session after InvokeCodeInterpreter fails against a cached one", async () => {
    memoryMock
      .on(StartCodeInterpreterSessionCommand)
      .resolvesOnce({ sessionId: "sandbox-stale", createdAt: new Date() })
      .resolvesOnce({ sessionId: "sandbox-fresh", createdAt: new Date() });
    memoryMock
      .on(InvokeCodeInterpreterCommand)
      .rejectsOnce(new Error("session expired"))
      .resolves(stdoutResult({ runningTotal: 100, breakdownByCity: {}, breakdownByCategory: {} }));
    const sessionId = aRuntimeSessionId();

    const first = await adapter.recordHold(sessionId, "TOKYO", "FLIGHT", aLocalPrice());
    const second = await adapter.recordHold(sessionId, "TOKYO", "FLIGHT", aLocalPrice());

    expect(first).toEqual({ ok: false, error: expect.objectContaining({ type: "SandboxUnavailable" }) });
    expect(second.ok).toBe(true);
    const invokeCalls = memoryMock.commandCalls(InvokeCodeInterpreterCommand);
    expect(invokeCalls[0]?.args[0].input.sessionId).toBe("sandbox-stale");
    expect(invokeCalls[1]?.args[0].input.sessionId).toBe("sandbox-fresh");
  });

  it("starts separate sandbox sessions for different runtime sessions", async () => {
    memoryMock
      .on(StartCodeInterpreterSessionCommand)
      .resolvesOnce({ sessionId: "sandbox-a", createdAt: new Date() })
      .resolvesOnce({ sessionId: "sandbox-b", createdAt: new Date() });
    memoryMock
      .on(InvokeCodeInterpreterCommand)
      .resolves(stdoutResult({ runningTotal: 100, breakdownByCity: {}, breakdownByCategory: {} }));

    await adapter.recordHold(aRuntimeSessionId("a"), "TOKYO", "FLIGHT", aLocalPrice());
    await adapter.recordHold(aRuntimeSessionId("b"), "PARIS", "HOTEL", aLocalPrice());

    const invokeCalls = memoryMock.commandCalls(InvokeCodeInterpreterCommand);
    expect(invokeCalls[0]?.args[0].input.sessionId).toBe("sandbox-a");
    expect(invokeCalls[1]?.args[0].input.sessionId).toBe("sandbox-b");
  });

  it("parses the sandbox's structured stdout into a BudgetSnapshot", async () => {
    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock.on(InvokeCodeInterpreterCommand).resolves(
      stdoutResult({
        runningTotal: 999.4,
        breakdownByCity: { TOKYO: 999.4 },
        breakdownByCategory: { FLIGHT: 549.4, HOTEL: 450 },
      }),
    );

    const result = await adapter.recordHold(aRuntimeSessionId(), "TOKYO", "HOTEL", aLocalPrice());

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.toJSON()).toEqual({
      runningTotal: 999.4,
      breakdownByCity: { TOKYO: 999.4 },
      breakdownByCategory: { FLIGHT: 549.4, HOTEL: 450 },
    });
  });

  it("returns SandboxUnavailable when starting the sandbox session fails", async () => {
    memoryMock.on(StartCodeInterpreterSessionCommand).rejects(new ThrottlingException({ message: "slow down", $metadata: {} }));

    const result = await adapter.recordHold(aRuntimeSessionId(), "TOKYO", "FLIGHT", aLocalPrice());

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "SandboxUnavailable" }) });
  });

  it("returns SandboxUnavailable when the InvokeCodeInterpreter call itself fails", async () => {
    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock.on(InvokeCodeInterpreterCommand).rejects(new Error("timed out"));

    const result = await adapter.recordHold(aRuntimeSessionId(), "TOKYO", "FLIGHT", aLocalPrice());

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "SandboxUnavailable" }) });
  });

  it("returns SandboxUnavailable when the stream carries a named service exception", async () => {
    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock.on(InvokeCodeInterpreterCommand).resolves({
      stream: codeInterpreterStream({
        validationException: new ValidationException({ message: "bad request", reason: "CannotParse", $metadata: {} }),
      }),
    });

    const result = await adapter.recordHold(aRuntimeSessionId(), "TOKYO", "FLIGHT", aLocalPrice());

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "SandboxUnavailable" }) });
  });

  it("returns ExecutionFailed when the executed code raises (e.g. an unmapped currency)", async () => {
    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock.on(InvokeCodeInterpreterCommand).resolves({
      stream: codeInterpreterStream({
        result: { content: [{ type: "text", text: "ValueError: no mock rate for currency XYZ" }], isError: true },
      }),
    });

    const result = await adapter.recordHold(aRuntimeSessionId(), "TOKYO", "FLIGHT", aLocalPrice({ currency: "XYZ" }));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "ExecutionFailed" }) });
  });

  it("returns ExecutionFailed when the sandbox's stdout isn't valid JSON", async () => {
    memoryMock.on(StartCodeInterpreterSessionCommand).resolves({ sessionId: "sandbox-1", createdAt: new Date() });
    memoryMock.on(InvokeCodeInterpreterCommand).resolves({
      stream: codeInterpreterStream({ result: { content: [{ type: "text", text: "not json" }], isError: false } }),
    });

    const result = await adapter.recordHold(aRuntimeSessionId(), "TOKYO", "FLIGHT", aLocalPrice());

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "ExecutionFailed" }) });
  });
});

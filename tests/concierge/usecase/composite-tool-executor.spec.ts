import { describe, expect, it } from "vitest";
import { CompositeToolExecutor } from "../../../src/concierge/usecase/composite-tool-executor";
import type { ToolCall, ToolCallResult, ToolExecutor } from "../../../src/concierge/usecase/ports";

class StubToolExecutor implements ToolExecutor {
  public receivedCalls: ToolCall[] = [];
  constructor(private readonly result: ToolCallResult) {}

  async execute(call: ToolCall): Promise<ToolCallResult> {
    this.receivedCalls.push(call);
    return this.result;
  }
}

describe("CompositeToolExecutor", () => {
  it("routes a call to the executor whose toolNames declares it", async () => {
    const booking = new StubToolExecutor({ toolUseId: "call-1", isError: false, content: "booking" });
    const calendar = new StubToolExecutor({ toolUseId: "call-2", isError: false, content: "calendar" });
    const executor = new CompositeToolExecutor([
      { toolNames: ["search-flights"], executor: booking },
      { toolNames: ["write-calendar-event"], executor: calendar },
    ]);

    const result = await executor.execute({ toolUseId: "call-2", name: "write-calendar-event", input: {} });

    expect(result).toEqual({ toolUseId: "call-2", isError: false, content: "calendar" });
    expect(booking.receivedCalls).toEqual([]);
    expect(calendar.receivedCalls).toHaveLength(1);
  });

  it("reports an unrouted tool name as a tool error without calling any executor", async () => {
    const booking = new StubToolExecutor({ toolUseId: "x", isError: false, content: "booking" });
    const executor = new CompositeToolExecutor([{ toolNames: ["search-flights"], executor: booking }]);

    const result = await executor.execute({ toolUseId: "call-3", name: "unknown-tool", input: {} });

    expect(result).toEqual({
      toolUseId: "call-3",
      isError: true,
      content: { error: "unknown tool: unknown-tool" },
    });
    expect(booking.receivedCalls).toEqual([]);
  });
});

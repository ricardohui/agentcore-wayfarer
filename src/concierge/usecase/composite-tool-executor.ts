import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { ToolCall, ToolCallResult, ToolExecutor } from "./ports";

export type RoutedToolExecutor = {
  readonly toolNames: readonly string[];
  readonly executor: ToolExecutor;
};

// Dispatches by tool name to one of several ToolExecutors (issue #17 adds
// write-calendar-event alongside issue #15's booking tools) — the model sees
// one flat tool catalog, but each concern (booking, calendar) keeps its own
// ToolExecutor, port, and adapter.
export class CompositeToolExecutor implements ToolExecutor {
  constructor(private readonly routes: readonly RoutedToolExecutor[]) {}

  async execute(call: ToolCall, sessionId: RuntimeSessionId): Promise<ToolCallResult> {
    const route = this.routes.find((candidate) => candidate.toolNames.includes(call.name));
    if (!route) {
      return { toolUseId: call.toolUseId, isError: true, content: { error: `unknown tool: ${call.name}` } };
    }
    return route.executor.execute(call, sessionId);
  }
}

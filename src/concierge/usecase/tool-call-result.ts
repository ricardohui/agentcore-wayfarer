import type { ToolCallResult } from "./ports";

// Shared tool-result envelope builders — every ToolExecutor (booking,
// calendar, and any future one) reports through this same
// `{toolUseId, isError, content}` shape, so it's built in one place rather
// than re-implemented per executor.
export function toolError(toolUseId: string, message: string, extra: Record<string, unknown> = {}): ToolCallResult {
  return { toolUseId, isError: true, content: { error: message, ...extra } };
}

export function toolSuccess(toolUseId: string, content: unknown): ToolCallResult {
  return { toolUseId, isError: false, content };
}

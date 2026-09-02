import type { CalendarEvent } from "../domain/calendar-event";
import type { HoldId } from "../domain/hold";
import { parseNonBlankId } from "../domain/non-blank-id";
import { CALENDAR_TOOL_DEFINITIONS, type CalendarToolName } from "./calendar-tool-catalog";
import type { CalendarPort, ToolCall, ToolCallResult, ToolExecutor } from "./ports";
import { toolError, toolSuccess } from "./tool-call-result";

export const CALENDAR_TOOL_NAMES = CALENDAR_TOOL_DEFINITIONS.map((definition) => definition.name);

function isCalendarToolName(name: string): name is CalendarToolName {
  return (CALENDAR_TOOL_NAMES as readonly string[]).includes(name);
}

function serializeEvent(event: CalendarEvent) {
  return { eventId: event.eventId, holdId: event.holdId, title: event.title };
}

// Dispatches the model's write-calendar-event tool-use call to the Delegated
// credential's CalendarPort (issue #17). A ConsentRequired failure isn't a
// broken call — its authorizationUrl is exactly what the model needs to
// surface to the Caller so the consent handshake (ADR-0003) can proceed.
export class CalendarToolExecutor implements ToolExecutor {
  constructor(private readonly calendar: CalendarPort) {}

  async execute(call: ToolCall): Promise<ToolCallResult> {
    if (!isCalendarToolName(call.name)) {
      return toolError(call.toolUseId, `unknown tool: ${call.name}`);
    }

    const input = (call.input ?? {}) as Record<string, unknown>;
    const holdId = parseNonBlankId<"HoldId">("holdId", String(input.holdId ?? ""));
    if (!holdId.ok) {
      return toolError(call.toolUseId, holdId.error.message);
    }
    const title = String(input.title ?? "");
    if (title.trim().length === 0) {
      return toolError(call.toolUseId, "title must not be blank");
    }

    const result = await this.calendar.writeEvent(holdId.value as HoldId, title);
    if (!result.ok) {
      const error = result.error;
      return toolError(
        call.toolUseId,
        error.message,
        error.type === "ConsentRequired" ? { authorizationUrl: error.authorizationUrl } : {},
      );
    }
    return toolSuccess(call.toolUseId, serializeEvent(result.value));
  }
}

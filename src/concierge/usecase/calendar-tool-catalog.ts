// Single source of truth for the Concierge's own calendar-write tool (issue
// #17 / ADR-0003) — a direct Concierge-owned tool backed by a Delegated
// credential, not a Gateway target like BOOKING_TOOL_DEFINITIONS. Imported by
// both BedrockConverseModelClient (the contract shown to the model) and
// CalendarToolExecutor (the contract it dispatches), so the two can't drift.
export type CalendarToolName = "write-calendar-event";

export type CalendarToolDefinition = {
  readonly name: CalendarToolName;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, { readonly type: string; readonly description?: string }>;
    readonly required: readonly string[];
  };
};

export const CALENDAR_TOOL_DEFINITIONS: readonly CalendarToolDefinition[] = [
  {
    name: "write-calendar-event",
    description:
      "Write a calendar event confirming a held flight or hotel booking. Requires the Caller's " +
      "one-time delegated authorization — if not yet granted, surface the returned authorization " +
      "URL to the Caller and retry this same call once they say they've approved it.",
    inputSchema: {
      type: "object",
      properties: {
        holdId: { type: "string", description: "The holdId of the flight or hotel hold to confirm." },
        title: { type: "string", description: "A short human-readable title for the calendar event." },
      },
      required: ["holdId", "title"],
    },
  },
];

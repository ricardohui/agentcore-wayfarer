import { describe, expect, it } from "vitest";
import { CalendarEvent } from "../../../src/concierge/domain/calendar-event";

describe("CalendarEvent.parse", () => {
  it("parses a well-formed raw event from the mock calendar-events store", () => {
    const result = CalendarEvent.parse({ eventId: "event-1", holdId: "hold-1", title: "Tokyo trip" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventId).toBe("event-1");
      expect(result.value.holdId).toBe("hold-1");
      expect(result.value.title).toBe("Tokyo trip");
    }
  });

  it("rejects a blank eventId", () => {
    const result = CalendarEvent.parse({ eventId: "", holdId: "hold-1", title: "Tokyo trip" });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "calendarEvent.eventId" }),
    });
  });

  it("rejects a non-object raw value", () => {
    const result = CalendarEvent.parse(42);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "calendarEvent" }),
    });
  });
});

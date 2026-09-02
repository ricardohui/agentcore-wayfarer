import type { HoldId } from "./hold";
import { parseNonBlankId } from "./non-blank-id";
import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export type CalendarEventId = string & { readonly __brand: "CalendarEventId" };

// A calendar write confirming a held booking (ADR-0003) — the mock
// calendar-events store's record, written via the Delegated credential once
// the consent handshake has completed.
export class CalendarEvent {
  constructor(
    public readonly eventId: CalendarEventId,
    public readonly holdId: HoldId,
    public readonly title: string,
  ) {}

  static parse(raw: unknown): Result<CalendarEvent, ValidationError> {
    if (typeof raw !== "object" || raw === null) {
      return err(validationError("calendarEvent", "must be an object"));
    }
    const record = raw as Record<string, unknown>;

    const eventId = parseNonBlankId<"CalendarEventId">("calendarEvent.eventId", String(record.eventId ?? ""));
    if (!eventId.ok) {
      return eventId;
    }

    const holdId = parseNonBlankId<"HoldId">("calendarEvent.holdId", String(record.holdId ?? ""));
    if (!holdId.ok) {
      return holdId;
    }

    const title = String(record.title ?? "");
    if (title.trim().length === 0) {
      return err(validationError("calendarEvent.title", "must not be blank"));
    }

    return ok(new CalendarEvent(eventId.value, holdId.value as HoldId, title));
  }
}

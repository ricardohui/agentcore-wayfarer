import { describe, expect, it } from "vitest";
import { CalendarEvent } from "../../../src/concierge/domain/calendar-event";
import type { DelegatedCredentialError } from "../../../src/concierge/domain/delegated-credential-error";
import type { Result } from "../../../src/concierge/domain/result";
import type { CalendarPort } from "../../../src/concierge/usecase/ports";
import { CalendarToolExecutor } from "../../../src/concierge/usecase/calendar-tool-executor";
import { aRuntimeSessionId } from "../support/object-mothers";

class FakeCalendarPort implements CalendarPort {
  public receivedCalls: { holdId: string; title: string }[] = [];
  private nextResult: Result<CalendarEvent, DelegatedCredentialError> | undefined;

  respondWith(result: Result<CalendarEvent, DelegatedCredentialError>): void {
    this.nextResult = result;
  }

  async writeEvent(holdId: string, title: string): Promise<Result<CalendarEvent, DelegatedCredentialError>> {
    this.receivedCalls.push({ holdId, title });
    if (!this.nextResult) {
      throw new Error("FakeCalendarPort.writeEvent called before respondWith");
    }
    return this.nextResult;
  }
}

function anEvent(): CalendarEvent {
  const parsed = CalendarEvent.parse({ eventId: "event-1", holdId: "hold-1", title: "Tokyo trip" });
  if (!parsed.ok) {
    throw new Error("fixture is invalid");
  }
  return parsed.value;
}

describe("CalendarToolExecutor", () => {
  it("writes a calendar event and returns it as tool success content", async () => {
    const calendar = new FakeCalendarPort();
    calendar.respondWith({ ok: true, value: anEvent() });
    const executor = new CalendarToolExecutor(calendar);

    const result = await executor.execute(
      { toolUseId: "call-1", name: "write-calendar-event", input: { holdId: "hold-1", title: "Tokyo trip" } },
      aRuntimeSessionId(),
    );

    expect(calendar.receivedCalls).toEqual([{ holdId: "hold-1", title: "Tokyo trip" }]);
    expect(result).toEqual({
      toolUseId: "call-1",
      isError: false,
      content: { eventId: "event-1", holdId: "hold-1", title: "Tokyo trip" },
    });
  });

  it("surfaces a ConsentRequired failure as tool error content carrying the authorizationUrl", async () => {
    const calendar = new FakeCalendarPort();
    calendar.respondWith({
      ok: false,
      error: {
        type: "ConsentRequired",
        message: "not authorized",
        authorizationUrl: "https://calendar.example.com/authorize?state=abc",
      },
    });
    const executor = new CalendarToolExecutor(calendar);

    const result = await executor.execute(
      { toolUseId: "call-2", name: "write-calendar-event", input: { holdId: "hold-1", title: "Tokyo trip" } },
      aRuntimeSessionId(),
    );

    expect(result).toEqual({
      toolUseId: "call-2",
      isError: true,
      content: {
        error: "not authorized",
        authorizationUrl: "https://calendar.example.com/authorize?state=abc",
      },
    });
  });

  it("rejects a blank holdId without calling the port", async () => {
    const calendar = new FakeCalendarPort();
    const executor = new CalendarToolExecutor(calendar);

    const result = await executor.execute(
      { toolUseId: "call-3", name: "write-calendar-event", input: { holdId: "", title: "Tokyo trip" } },
      aRuntimeSessionId(),
    );

    expect(calendar.receivedCalls).toEqual([]);
    expect(result.isError).toBe(true);
  });

  it("reports an unknown tool name as a tool error", async () => {
    const calendar = new FakeCalendarPort();
    const executor = new CalendarToolExecutor(calendar);

    const result = await executor.execute(
      { toolUseId: "call-4", name: "some-other-tool", input: {} },
      aRuntimeSessionId(),
    );

    expect(result).toEqual({
      toolUseId: "call-4",
      isError: true,
      content: { error: "unknown tool: some-other-tool" },
    });
  });
});

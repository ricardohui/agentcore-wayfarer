import type { MockAgent } from "undici";

export const CALENDAR_API_URL = "https://test-calendar.example.com";

// Registers onto the shared NetworkBoundary's MockAgent, standing in for the
// mock calendar-events store (ADR-0003) that DelegatedCalendarAdapter writes
// to once Identity's token vault holds a Delegated credential.
export class CalendarMockServer {
  public readonly writtenEvents: { holdId: string; title: string; authorizationHeader: string | undefined }[] = [];

  constructor(agent: MockAgent) {
    const url = new URL(CALENDAR_API_URL);
    agent
      .get(url.origin)
      .intercept({ path: "/events", method: "POST" })
      .reply(200, (opts) => {
        const body = JSON.parse(String(opts.body ?? "{}")) as { holdId: string; title: string };
        const headers = opts.headers as Record<string, string>;
        this.writtenEvents.push({
          ...body,
          authorizationHeader: headers.authorization ?? headers.Authorization,
        });
        return { eventId: `event-${this.writtenEvents.length}`, holdId: body.holdId, title: body.title };
      })
      .persist();
  }
}

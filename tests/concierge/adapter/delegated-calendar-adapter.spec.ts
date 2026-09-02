import { BedrockAgentCoreClient, GetResourceOauth2TokenCommand } from "@aws-sdk/client-bedrock-agentcore";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DelegatedCalendarAdapter } from "../../../src/concierge/adapter/delegated-calendar-adapter";
import type { HoldId } from "../../../src/concierge/domain/hold";
import { memoryMock } from "../support/memory-network-boundary";

const PROVIDER_NAME = "wayfarer-calendar-oauth2";
const CALENDAR_API_URL = "https://test-calendar.example.com";
const HOLD_ID = "hold-1" as HoldId;

describe("DelegatedCalendarAdapter", () => {
  let agent: MockAgent;
  let previousDispatcher: Dispatcher;

  beforeEach(() => {
    memoryMock.reset();
    previousDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previousDispatcher);
  });

  function anAdapter(workloadIdentityToken: () => Promise<string>): DelegatedCalendarAdapter {
    return new DelegatedCalendarAdapter(
      new BedrockAgentCoreClient({}),
      PROVIDER_NAME,
      CALENDAR_API_URL,
      undefined,
      workloadIdentityToken,
    );
  }

  it("returns IdentityUnavailable when no workload identity token is available", async () => {
    const adapter = anAdapter(() => Promise.reject(new Error("No workload access token in context.")));

    const result = await adapter.writeEvent(HOLD_ID, "Tokyo trip");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "IdentityUnavailable" }),
    });
  });

  it("returns ConsentRequired carrying the authorizationUrl when Identity has no vaulted credential yet", async () => {
    memoryMock.on(GetResourceOauth2TokenCommand).resolves({
      authorizationUrl: "https://calendar-oauth.example.com/authorize?state=abc",
    });
    const adapter = anAdapter(() => Promise.resolve("wat-token"));

    const result = await adapter.writeEvent(HOLD_ID, "Tokyo trip");

    expect(result).toEqual({
      ok: false,
      error: {
        type: "ConsentRequired",
        message: expect.any(String),
        authorizationUrl: "https://calendar-oauth.example.com/authorize?state=abc",
      },
    });
    const calls = memoryMock.commandCalls(GetResourceOauth2TokenCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      resourceCredentialProviderName: PROVIDER_NAME,
      oauth2Flow: "USER_FEDERATION",
      workloadIdentityToken: "wat-token",
    });
  });

  it("writes the calendar event once Identity's token vault holds a credential", async () => {
    memoryMock.on(GetResourceOauth2TokenCommand).resolves({ accessToken: "calendar-access-token" });
    const url = new URL(CALENDAR_API_URL);
    let receivedAuthHeader: string | null = null;
    let receivedBody: unknown;
    agent
      .get(url.origin)
      .intercept({ path: "/events", method: "POST" })
      .reply(200, (opts) => {
        receivedAuthHeader = String(
          (opts.headers as Record<string, string>).authorization ?? (opts.headers as Record<string, string>).Authorization,
        );
        receivedBody = JSON.parse(String(opts.body ?? "{}"));
        return { eventId: "event-1", holdId: HOLD_ID, title: "Tokyo trip" };
      });

    const adapter = anAdapter(() => Promise.resolve("wat-token"));
    const result = await adapter.writeEvent(HOLD_ID, "Tokyo trip");

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ eventId: "event-1", holdId: HOLD_ID, title: "Tokyo trip" }),
    });
    expect(receivedAuthHeader).toBe("Bearer calendar-access-token");
    expect(receivedBody).toEqual({ holdId: HOLD_ID, title: "Tokyo trip" });
  });

  it("returns CalendarUnavailable when the calendar API rejects the write", async () => {
    memoryMock.on(GetResourceOauth2TokenCommand).resolves({ accessToken: "calendar-access-token" });
    const url = new URL(CALENDAR_API_URL);
    agent.get(url.origin).intercept({ path: "/events", method: "POST" }).reply(500, { error: "boom" });

    const adapter = anAdapter(() => Promise.resolve("wat-token"));
    const result = await adapter.writeEvent(HOLD_ID, "Tokyo trip");

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "CalendarUnavailable" }) });
  });

  it("returns IdentityUnavailable when GetResourceOauth2Token fails", async () => {
    memoryMock.on(GetResourceOauth2TokenCommand).rejects(new Error("service unavailable"));
    const adapter = anAdapter(() => Promise.resolve("wat-token"));

    const result = await adapter.writeEvent(HOLD_ID, "Tokyo trip");

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "IdentityUnavailable" }) });
  });
});

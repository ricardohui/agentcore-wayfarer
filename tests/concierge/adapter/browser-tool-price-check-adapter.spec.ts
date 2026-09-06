import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserToolPriceCheckAdapter } from "../../../src/concierge/adapter/browser-tool-price-check-adapter";
import type { FlightCandidateId } from "../../../src/concierge/domain/flight-candidate";

const navigateMock = vi.fn();
const getTextMock = vi.fn();
const stopSessionMock = vi.fn();

// The real adapter's only network boundary is bedrock-agentcore's Browser
// Tool client — a real CDP session over a signed WebSocket has no existing
// interception harness in this repo (unlike the undici MockAgent used for
// plain HTTP, or aws-sdk-client-mock used for AWS SDK calls), so this mocks
// the client module itself, the same way a raw HTTP client or AWS SDK would
// be intercepted at its own boundary elsewhere. vi.mock is hoisted above
// this file's imports, so the adapter above already sees the fake.
vi.mock("bedrock-agentcore/browser/playwright", () => ({
  PlaywrightBrowser: vi.fn().mockImplementation(() => ({
    navigate: navigateMock,
    getText: getTextMock,
    stopSession: stopSessionMock,
  })),
}));

const REGION = "us-east-1";
const BROWSER_ID = "test-browser-id";
const SITE_URL = "http://example-price-check-site.s3-website-us-east-1.amazonaws.com/index.html";
const CANDIDATE_ID = "flight-1" as FlightCandidateId;

describe("BrowserToolPriceCheckAdapter", () => {
  let adapter: BrowserToolPriceCheckAdapter;

  beforeEach(() => {
    navigateMock.mockReset().mockResolvedValue(undefined);
    getTextMock.mockReset();
    stopSessionMock.mockReset().mockResolvedValue(undefined);
    adapter = new BrowserToolPriceCheckAdapter(REGION, BROWSER_ID, SITE_URL);
  });

  it("navigates to the price-check site with candidateId/city query params and parses the returned price", async () => {
    getTextMock.mockResolvedValue(JSON.stringify({ amount: 79500, currency: "JPY" }));

    const result = await adapter.checkPrice(CANDIDATE_ID, "TOKYO");

    expect(navigateMock).toHaveBeenCalledWith({ url: `${SITE_URL}?candidateId=flight-1&city=TOKYO` });
    expect(getTextMock).toHaveBeenCalledWith({ selector: "#live-price-json" });
    expect(stopSessionMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.toJSON()).toEqual({ amount: 79500, currency: "JPY" });
  });

  it("returns NavigationFailed when the Browser Tool session fails to navigate", async () => {
    navigateMock.mockRejectedValue(new Error("browser session failed to start"));

    const result = await adapter.checkPrice(CANDIDATE_ID, "TOKYO");

    expect(result).toEqual({
      ok: false,
      error: { type: "NavigationFailed", message: "browser session failed to start" },
    });
    // Cleanup is still attempted even though navigation never completed.
    expect(stopSessionMock).toHaveBeenCalledTimes(1);
  });

  it("returns NavigationFailed when reading the live price element fails", async () => {
    getTextMock.mockRejectedValue(new Error("Element not found: #live-price-json"));

    const result = await adapter.checkPrice(CANDIDATE_ID, "TOKYO");

    expect(result).toEqual({
      ok: false,
      error: { type: "NavigationFailed", message: "Element not found: #live-price-json" },
    });
  });

  it("returns MalformedPrice when the page returns non-JSON content", async () => {
    getTextMock.mockResolvedValue("pending");

    const result = await adapter.checkPrice(CANDIDATE_ID, "TOKYO");

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "MalformedPrice" }) });
  });

  it("returns MalformedPrice when the parsed JSON isn't a valid LocalPrice", async () => {
    getTextMock.mockResolvedValue(JSON.stringify({ amount: -5, currency: "JPY" }));

    const result = await adapter.checkPrice(CANDIDATE_ID, "TOKYO");

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "MalformedPrice" }) });
  });

  it("still returns the parsed price when the session's own teardown fails", async () => {
    getTextMock.mockResolvedValue(JSON.stringify({ amount: 340, currency: "USD" }));
    stopSessionMock.mockRejectedValue(new Error("session already terminated"));

    const result = await adapter.checkPrice(CANDIDATE_ID, "NEW_YORK");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.toJSON()).toEqual({ amount: 340, currency: "USD" });
  });
});

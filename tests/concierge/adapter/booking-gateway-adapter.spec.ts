import { fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookingGatewayAdapter } from "../../../src/concierge/adapter/booking-gateway-adapter";
import { GatewayMockServer } from "../support/gateway-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";
import { aRuntimeSessionId } from "../support/object-mothers";

// Integration coverage for Cedar policy syntax/evaluation edge cases (issue
// #20 / ADR-0006): this is the seam that turns Policy's ENFORCE-mode
// decision — surfaced over MCP as an ordinary isError tool response, not a
// distinct wire-level error — into a domain-typed HoldGated GatewayError,
// and the seam that threads the policy session header a Cedar temporal rule
// correlates hold-flight/hold-hotel/approve-hold against.
describe("BookingGatewayAdapter (issue #20 / ADR-0006)", () => {
  let network: NetworkBoundary;
  let gateway: GatewayMockServer;
  let adapter: BookingGatewayAdapter;

  beforeEach(() => {
    network = new NetworkBoundary();
    gateway = new GatewayMockServer(network.agent);
    adapter = new BookingGatewayAdapter(
      "https://test-gateway.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      undiciFetch,
    );
  });

  afterEach(async () => {
    await network.close();
  });

  it("maps a Policy denial's AuthorizeActionException text to a HoldGated GatewayError", async () => {
    gateway.respondToTool("hold-flight", {
      isError: true,
      content:
        "AuthorizeActionException - Tool Execution Denied: Tool call not allowed due to policy enforcement [No policy applies to the request (denied by default).]",
    });

    const result = await adapter.holdFlight("flight-1" as never, 900, aRuntimeSessionId());

    expect(result).toEqual({
      ok: false,
      error: { type: "HoldGated", message: expect.stringContaining("policy enforcement") },
    });
  });

  it("maps a Policy denial on hold-hotel the same way", async () => {
    gateway.respondToTool("hold-hotel", {
      isError: true,
      content: "AuthorizeActionException - Tool Execution Denied: Tool call not allowed due to policy enforcement [...]",
    });

    const result = await adapter.holdHotel("hotel-1" as never, 900, aRuntimeSessionId());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.type).toBe("HoldGated");
  });

  it("still maps a denial mentioning only 'policy enforcement', without AuthorizeActionException, to HoldGated", async () => {
    gateway.respondToTool("hold-flight", {
      isError: true,
      content: "Tool call not allowed due to policy enforcement [denied by a forbid rule]",
    });

    const result = await adapter.holdFlight("flight-1" as never, 900, aRuntimeSessionId());

    expect(result).toEqual({
      ok: false,
      error: { type: "HoldGated", message: expect.stringContaining("policy enforcement") },
    });
  });

  it("still maps a non-policy Gateway failure to GatewayUnavailable", async () => {
    gateway.respondToTool("hold-flight", { isError: true, content: "Lambda timed out" });

    const result = await adapter.holdFlight("flight-1" as never, 100, aRuntimeSessionId());

    expect(result).toEqual({ ok: false, error: { type: "GatewayUnavailable", message: "Lambda timed out" } });
  });

  it("sends the candidate's price alongside candidateId on a hold-flight call", async () => {
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    await adapter.holdFlight("flight-1" as never, 900, aRuntimeSessionId());

    expect(gateway.receivedToolCalls).toMatchObject([
      { name: "hold-flight", arguments: { candidateId: "flight-1", price: 900 } },
    ]);
  });

  it("carries the sessionId as the Policy session header on a hold-flight call", async () => {
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });
    const sessionId = aRuntimeSessionId("policy-session");

    await adapter.holdFlight("flight-1" as never, 900, sessionId);

    expect(gateway.receivedToolCalls[0]?.policySessionHeader).toBe(sessionId);
  });

  it("dispatches approve-hold with no arguments and the Policy session header", async () => {
    gateway.respondToTool("approve-hold", { content: { approved: true } });
    const sessionId = aRuntimeSessionId("approve");

    const result = await adapter.approveHold(sessionId);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(gateway.receivedToolCalls).toMatchObject([{ name: "approve-hold", arguments: {} }]);
    expect(gateway.receivedToolCalls[0]?.policySessionHeader).toBe(sessionId);
  });
});

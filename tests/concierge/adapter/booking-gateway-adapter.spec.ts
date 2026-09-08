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
// and the seam that carries the `approved` flag Policy's stateless
// approved-retry Cedar rule reads (ADR-0006, revised: no Dogwood temporal
// rule, see issue #20).
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

    const result = await adapter.holdFlight("flight-1" as never, 900, false, aRuntimeSessionId());

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

    const result = await adapter.holdHotel("hotel-1" as never, 900, false, aRuntimeSessionId());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.type).toBe("HoldGated");
  });

  it("still maps a denial mentioning only 'policy enforcement', without AuthorizeActionException, to HoldGated", async () => {
    gateway.respondToTool("hold-flight", {
      isError: true,
      content: "Tool call not allowed due to policy enforcement [denied by a forbid rule]",
    });

    const result = await adapter.holdFlight("flight-1" as never, 900, false, aRuntimeSessionId());

    expect(result).toEqual({
      ok: false,
      error: { type: "HoldGated", message: expect.stringContaining("policy enforcement") },
    });
  });

  // Confirmed live against the deployed Gateway (issue #20): a Policy denial
  // arrives as a genuine JSON-RPC-level error (the MCP SDK throws an
  // McpError for it), not as a normal result with isError:true — a
  // different code path than the isError:true tests above, which is how
  // this went uncaught until a live probe surfaced it.
  it("maps a Policy denial that arrives as a thrown protocol-level error to HoldGated, not GatewayUnavailable", async () => {
    gateway.respondToTool("hold-flight", {
      protocolError: {
        code: -32002,
        message:
          "MCP error -32002: Tool Execution Denied: Tool call not allowed due to policy enforcement [No policy applies to the request (denied by default).]",
      },
    });

    const result = await adapter.holdFlight("flight-1" as never, 900, false, aRuntimeSessionId());

    expect(result).toEqual({
      ok: false,
      error: { type: "HoldGated", message: expect.stringContaining("policy enforcement") },
    });
  });

  it("still maps a non-policy Gateway failure to GatewayUnavailable", async () => {
    gateway.respondToTool("hold-flight", { isError: true, content: "Lambda timed out" });

    const result = await adapter.holdFlight("flight-1" as never, 100, false, aRuntimeSessionId());

    expect(result).toEqual({ ok: false, error: { type: "GatewayUnavailable", message: "Lambda timed out" } });
  });

  it("sends the candidate's price alongside candidateId on a hold-flight call", async () => {
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    await adapter.holdFlight("flight-1" as never, 900, false, aRuntimeSessionId());

    expect(gateway.receivedToolCalls).toMatchObject([
      { name: "hold-flight", arguments: { candidateId: "flight-1", price: 900 } },
    ]);
  });

  it("sends approved:true on a hold-flight call carrying an unconsumed approval (issue #20 revision)", async () => {
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    await adapter.holdFlight("flight-1" as never, 900, true, aRuntimeSessionId());

    expect(gateway.receivedToolCalls).toMatchObject([
      { name: "hold-flight", arguments: { candidateId: "flight-1", price: 900, approved: true } },
    ]);
  });

  it("omits approved entirely on a hold-hotel call with no approval, matching tool-catalog's optional schema", async () => {
    gateway.respondToTool("hold-hotel", {
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    await adapter.holdHotel("hotel-1" as never, 900, false, aRuntimeSessionId());

    const [call] = gateway.receivedToolCalls;
    expect(call?.arguments).not.toHaveProperty("approved");
  });

  // Confirmed live against the deployed Gateway (issue #20 revision): the
  // Policy session header itself, whenever present, makes every Gateway
  // action fail with a generic "An internal error occurred" — independent
  // of the Policy engine's policy content (temporal or not), validationMode,
  // or which action is called. Sending it was never required once the gate
  // moved to stateless Cedar; now it's confirmed actively harmful, so the
  // adapter must never send it.
  it("does not send the Policy session header on a hold-flight call", async () => {
    gateway.respondToTool("hold-flight", {
      content: { holdId: "hold-1", status: "held", expiresAt: "2026-09-01T00:00:00.000Z" },
    });

    await adapter.holdFlight("flight-1" as never, 900, false, aRuntimeSessionId());

    expect(gateway.receivedToolCalls[0]?.policySessionHeader).toBeUndefined();
  });

  it("does not send the Policy session header on a search-flights call", async () => {
    gateway.respondToTool("search-flights", { content: [] });

    await adapter.searchFlights("TOKYO" as never, aRuntimeSessionId());

    expect(gateway.receivedToolCalls[0]?.policySessionHeader).toBeUndefined();
  });

  it("does not send the Policy session header on a search-hotels call", async () => {
    gateway.respondToTool("search-hotels", { content: [] });

    await adapter.searchHotels("TOKYO" as never, aRuntimeSessionId());

    expect(gateway.receivedToolCalls[0]?.policySessionHeader).toBeUndefined();
  });

  it("dispatches approve-hold with no arguments and no Policy session header", async () => {
    gateway.respondToTool("approve-hold", { content: { approved: true } });

    const result = await adapter.approveHold(aRuntimeSessionId());

    expect(result).toEqual({ ok: true, value: undefined });
    expect(gateway.receivedToolCalls).toMatchObject([{ name: "approve-hold", arguments: {} }]);
    expect(gateway.receivedToolCalls[0]?.policySessionHeader).toBeUndefined();
  });
});

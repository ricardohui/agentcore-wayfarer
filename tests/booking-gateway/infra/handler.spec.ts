import { describe, expect, it } from "vitest";
import { BOOKING_GATEWAY_TARGET_NAME } from "../../../src/booking-gateway/gateway-target-name";
import { handler, type GatewayLambdaContext } from "../../../src/booking-gateway/infra/handler";

function aContext(toolName: string): GatewayLambdaContext {
  return { clientContext: { custom: { bedrockAgentCoreToolName: `${BOOKING_GATEWAY_TARGET_NAME}___${toolName}` } } };
}

describe("booking-gateway router Lambda", () => {
  it("returns flight candidates across the destination for a search-flights call", async () => {
    const result = (await handler({ destination: "TOKYO" }, aContext("search-flights"))) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const candidate of result as Record<string, unknown>[]) {
      expect(candidate.destination).toBe("TOKYO");
      expect(candidate.price).toMatchObject({ currency: "JPY" });
      expect((candidate.price as { amount: number }).amount).toBeGreaterThan(0);
    }
  });

  it("returns hotel candidates for a search-hotels call", async () => {
    const result = (await handler({ city: "PARIS" }, aContext("search-hotels"))) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const candidate of result as Record<string, unknown>[]) {
      expect(candidate.city).toBe("PARIS");
      expect(candidate.price).toMatchObject({ currency: "EUR" });
    }
  });

  it("returns a hold for a hold-flight call", async () => {
    const result = (await handler(
      { candidateId: "flight-1" },
      aContext("hold-flight"),
    )) as Record<string, unknown>;

    expect(result.status).toBe("held");
    expect(typeof result.holdId).toBe("string");
    expect(new Date(String(result.expiresAt)).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns a hold for a hold-hotel call", async () => {
    const result = (await handler(
      { candidateId: "hotel-1" },
      aContext("hold-hotel"),
    )) as Record<string, unknown>;

    expect(result.status).toBe("held");
    expect(typeof result.holdId).toBe("string");
  });

  it("returns an error for a malformed payload missing the required field", async () => {
    const result = (await handler({}, aContext("search-flights"))) as Record<string, unknown>;

    expect(typeof result.error).toBe("string");
  });

  it("returns an error for a candidateId that isn't blank-checked", async () => {
    const result = (await handler({ candidateId: "" }, aContext("hold-flight"))) as Record<string, unknown>;

    expect(typeof result.error).toBe("string");
  });

  it("returns an error for an unknown operation", async () => {
    const result = (await handler({}, aContext("delete-everything"))) as Record<string, unknown>;

    expect(result.error).toBe("unknown operation: delete-everything");
  });

  it("returns an error when the Lambda context carries no tool name", async () => {
    const result = (await handler({}, {})) as Record<string, unknown>;

    expect(typeof result.error).toBe("string");
  });
});

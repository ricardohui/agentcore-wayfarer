import { describe, expect, it } from "vitest";
import { createDecimalPriceFetch } from "../../../src/concierge/adapter/decimal-price-fetch";
import type { FetchLike } from "../../../src/concierge/adapter/sigv4-fetch";

function fakeInnerFetch(): { fetch: FetchLike; receivedBodies: (string | undefined)[] } {
  const receivedBodies: (string | undefined)[] = [];
  const fetch: FetchLike = async (_url, init) => {
    receivedBodies.push(typeof init?.body === "string" ? init.body : undefined);
    return new Response(null, { status: 200 }) as unknown as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, receivedBodies };
}

describe("createDecimalPriceFetch", () => {
  it("appends a trailing decimal point to a whole-number price so Cedar's decimal wire format accepts it", async () => {
    const { fetch: inner, receivedBodies } = fakeInnerFetch();
    const decimalPriceFetch = createDecimalPriceFetch(inner);

    await decimalPriceFetch("https://gateway.example/mcp", {
      method: "POST",
      body: JSON.stringify({ params: { arguments: { candidateId: "c1", price: 100 } } }),
    });

    expect(receivedBodies[0]).toContain('"price":100.0000');
  });

  it("leaves an already-fractional price unchanged", async () => {
    const { fetch: inner, receivedBodies } = fakeInnerFetch();
    const decimalPriceFetch = createDecimalPriceFetch(inner);

    const body = JSON.stringify({ params: { arguments: { candidateId: "c1", price: 100.5 } } });
    await decimalPriceFetch("https://gateway.example/mcp", { method: "POST", body });

    expect(receivedBodies[0]).toBe(body);
  });

  it("leaves a request body with no price field unchanged", async () => {
    const { fetch: inner, receivedBodies } = fakeInnerFetch();
    const decimalPriceFetch = createDecimalPriceFetch(inner);

    const body = JSON.stringify({ params: { arguments: { destination: "TOKYO" } } });
    await decimalPriceFetch("https://gateway.example/mcp", { method: "POST", body });

    expect(receivedBodies[0]).toBe(body);
  });

  it("leaves a request with no body unchanged", async () => {
    const { fetch: inner, receivedBodies } = fakeInnerFetch();
    const decimalPriceFetch = createDecimalPriceFetch(inner);

    await decimalPriceFetch("https://gateway.example/mcp", { method: "GET" });

    expect(receivedBodies[0]).toBeUndefined();
  });
});

import type { FetchLike } from "./sigv4-fetch";

// Cedar's wire-format parser needs a literal decimal point to know a numeric
// literal is `decimal` rather than `Long` (issue #20 / ADR-0006) — the
// booking gateway's price argument is typed `decimal` even though it's a
// plain JS number here, and JSON.stringify can't emit a fractional part for a
// whole number. Rewriting the outgoing wire text is the only seam available:
// nothing upstream of serialization has a way to force that formatting. Uses
// 4 fractional digits to match this codebase's own Cedar decimal literals
// (e.g. decimal("500.0000") in booking-gateway-construct.ts).
const WHOLE_NUMBER_PRICE = /"price":(-?\d+)([,}])/g;

export function createDecimalPriceFetch(inner: FetchLike): FetchLike {
  return async (url, init) => {
    if (typeof init?.body !== "string") {
      return inner(url, init);
    }
    const patchedBody = init.body.replace(WHOLE_NUMBER_PRICE, '"price":$1.0000$2');
    return inner(url, { ...init, body: patchedBody });
  };
}

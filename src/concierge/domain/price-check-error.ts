// Browser Tool's price-check (issue #19 / ADR-0005): NavigationFailed covers
// a failure to reach or read the mock price-check site at all (session
// start, CDP navigation, or content extraction) — MalformedPrice covers a
// page that was reached but whose content didn't parse into a valid price.
export type PriceCheckError =
  | { readonly type: "NavigationFailed"; readonly message: string }
  | { readonly type: "MalformedPrice"; readonly message: string };

export type GatewayError =
  | { readonly type: "GatewayUnavailable"; readonly message: string }
  | { readonly type: "MalformedResponse"; readonly message: string }
  // Policy (issue #20 / ADR-0006) denied a hold-flight/hold-hotel call above
  // the flat Local-currency threshold with no unconsumed approve-hold event
  // — not a broken call, just "not approved yet".
  | { readonly type: "HoldGated"; readonly message: string };

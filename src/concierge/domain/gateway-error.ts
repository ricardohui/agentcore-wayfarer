export type GatewayError =
  | { readonly type: "GatewayUnavailable"; readonly message: string }
  | { readonly type: "MalformedResponse"; readonly message: string };

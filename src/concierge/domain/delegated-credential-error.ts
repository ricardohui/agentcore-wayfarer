// Identity's consent handshake (issue #17 / ADR-0003): the Concierge's first
// calendar write fails ConsentRequired, carrying the authorizationUrl to
// surface to the Caller mid-conversation — not itself a failure to report as
// broken, just "not authorized yet".
export type DelegatedCredentialError =
  | { readonly type: "ConsentRequired"; readonly message: string; readonly authorizationUrl: string }
  | { readonly type: "IdentityUnavailable"; readonly message: string }
  | { readonly type: "CalendarUnavailable"; readonly message: string };

import { createHash } from "node:crypto";
import { timingSafeStringEqual } from "./secure-compare";

// RFC 7636 S256: the stored code_challenge is the base64url-encoded SHA-256
// of the code_verifier the token exchange presents. The mock authorization
// server only supports S256 — plain is a real PKCE downgrade attack surface,
// not worth a "mock" exception.
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return timingSafeStringEqual(computed, codeChallenge);
}

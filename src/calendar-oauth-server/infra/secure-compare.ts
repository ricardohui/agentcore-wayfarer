import { timingSafeEqual } from "node:crypto";

// A plain `===` on a secret (client_secret, a PKCE digest) leaks timing
// information via JS's first-mismatched-byte short-circuit. Comparing
// byte length first only leaks length, a far weaker signal than leaking
// which byte differs.
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

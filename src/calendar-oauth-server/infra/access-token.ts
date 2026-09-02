import { jwtVerify, SignJWT } from "jose";

export const ACCESS_TOKEN_TTL_SECONDS = 3600;

// Real signed tokens (ADR-0003): HS256 over a Secrets-Manager-held key,
// verified the same way on every calendar-events request — not a bare
// opaque string, so a tampered or expired Bearer token is actually rejected.
export async function signAccessToken(sub: string, secret: Uint8Array, issuer: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secret);
}

export async function verifyAccessToken(
  token: string,
  secret: Uint8Array,
  issuer: string,
): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer });
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

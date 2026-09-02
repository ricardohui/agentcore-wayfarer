import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { MockAgent } from "undici";

export const COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool";
export const COGNITO_CLIENT_ID = "test-client-id";
export const DEFAULT_TEST_SUB = "caller-sub-1";

const KEY_ID = "test-key-1";

// CognitoJwtVerifier is built once at module load (matching production,
// where a real issuer's JWKS is stable and worth caching) — its
// createRemoteJWKSet cache is process-wide, so every test's CognitoMockServer
// must serve the *same* keypair, generated once here, or a token signed
// against a later test's fresh key would fail signature verification against
// an earlier test's still-cached JWKS response.
const keyPairPromise = generateKeyPair("RS256");

// Registers onto the shared NetworkBoundary's MockAgent, standing in for
// Cognito's JWKS endpoint — every acceptance test exercising the real
// CognitoJwtVerifier signs its Authorization header through this.
export class CognitoMockServer {
  private constructor(private readonly privateKey: CryptoKey) {}

  static async register(agent: MockAgent): Promise<CognitoMockServer> {
    const { privateKey, publicKey } = await keyPairPromise;
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };

    const url = new URL(`${COGNITO_ISSUER}/.well-known/jwks.json`);
    agent
      .get(url.origin)
      .intercept({ path: url.pathname, method: "GET" })
      .reply(200, { keys: [publicJwk] }, { headers: { "content-type": "application/json" } })
      .persist();

    return new CognitoMockServer(privateKey);
  }

  // Shaped like a real Cognito *access* token — the conventional bearer
  // credential for API calls — which carries `client_id`, not `aud`.
  async signToken(overrides: { sub?: string; expiresAt?: number } = {}): Promise<string> {
    return new SignJWT({ client_id: COGNITO_CLIENT_ID, token_use: "access" })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setSubject(overrides.sub ?? DEFAULT_TEST_SUB)
      .setIssuer(COGNITO_ISSUER)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(this.privateKey);
  }
}

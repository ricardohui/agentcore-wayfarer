import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CognitoJwtVerifier } from "../../../src/concierge/adapter/cognito-jwt-verifier";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool";
const AUDIENCE = "test-client-id";
const KEY_ID = "test-key-1";

describe("CognitoJwtVerifier", () => {
  let agent: MockAgent;
  let previousDispatcher: Dispatcher;
  let privateKey: CryptoKey;
  let verifier: CognitoJwtVerifier;

  beforeEach(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey;
    const publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };

    previousDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    setGlobalDispatcher(agent);
    const url = new URL(`${ISSUER}/.well-known/jwks.json`);
    agent
      .get(url.origin)
      .intercept({ path: url.pathname, method: "GET" })
      .reply(200, { keys: [publicJwk] }, { headers: { "content-type": "application/json" } })
      .persist();

    verifier = new CognitoJwtVerifier(ISSUER, AUDIENCE);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previousDispatcher);
  });

  // Shaped like a real Cognito *access* token — the conventional bearer
  // credential for API calls — which carries `client_id`, not `aud`.
  async function signAccessToken(overrides: {
    sub?: string;
    issuer?: string;
    clientId?: string;
    expiresAt?: number;
  } = {}): Promise<string> {
    return new SignJWT({ client_id: overrides.clientId ?? AUDIENCE, token_use: "access" })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setSubject(overrides.sub ?? "caller-sub-123")
      .setIssuer(overrides.issuer ?? ISSUER)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);
  }

  // Shaped like a real Cognito *ID* token — carries `aud`, not `client_id`.
  async function signIdToken(overrides: { sub?: string; audience?: string } = {}): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setSubject(overrides.sub ?? "caller-sub-123")
      .setIssuer(ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);
  }

  it("resolves the sub claim of a validly signed, unexpired access token as ActorId", async () => {
    const token = await signAccessToken({ sub: "caller-sub-123" });

    const result = await verifier.verify(`Bearer ${token}`);

    expect(result).toEqual({ ok: true, value: "caller-sub-123" });
  });

  it("resolves the sub claim of a validly signed ID token (aud instead of client_id) as ActorId", async () => {
    const token = await signIdToken({ sub: "caller-sub-123" });

    const result = await verifier.verify(`Bearer ${token}`);

    expect(result).toEqual({ ok: true, value: "caller-sub-123" });
  });

  it("rejects a missing Authorization header", async () => {
    const result = await verifier.verify(undefined);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "MissingToken" }) });
  });

  it("rejects a header without the Bearer scheme", async () => {
    const token = await signAccessToken();

    const result = await verifier.verify(token);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "MissingToken" }) });
  });

  it("rejects an expired token", async () => {
    const token = await signAccessToken({ expiresAt: Math.floor(Date.now() / 1000) - 60 });

    const result = await verifier.verify(`Bearer ${token}`);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "InvalidToken" }) });
  });

  it("rejects a token signed by a different key (invalid signature)", async () => {
    const otherKeyPair = await generateKeyPair("RS256");
    const token = await new SignJWT({ client_id: AUDIENCE })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setSubject("caller-sub-123")
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(otherKeyPair.privateKey);

    const result = await verifier.verify(`Bearer ${token}`);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "InvalidToken" }) });
  });

  it("rejects an access token issued for a different client_id", async () => {
    const token = await signAccessToken({ clientId: "some-other-client-id" });

    const result = await verifier.verify(`Bearer ${token}`);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "InvalidToken" }) });
  });

  it("rejects an ID token issued for a different audience", async () => {
    const token = await signIdToken({ audience: "some-other-client-id" });

    const result = await verifier.verify(`Bearer ${token}`);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "InvalidToken" }) });
  });
});

import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { fetch as undiciFetch } from "undici";
import type { ActorId } from "../domain/actor-id";
import { parseActorId } from "../domain/actor-id";
import type { AuthenticationError } from "../domain/authentication-error";
import { err, ok, type Result } from "../domain/result";
import type { JwtVerifierPort } from "../usecase/ports";

const BEARER_PREFIX = "Bearer ";

// Verifies the inbound Authorization header against Cognito's own JWKS
// (issue #17): a valid token's `sub` claim becomes ActorId, revising Memory's
// PLACEHOLDER_ACTOR_ID (issue #16) to the Caller's real inbound identity.
// AgentCore Runtime's platform-level JWT authorizer also rejects a bad token
// before this ever runs in production — this is defense-in-depth, and the
// only layer the local invocation server (and this repo's acceptance tests)
// can actually exercise.
export class CognitoJwtVerifier implements JwtVerifierPort {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    jwksUri: string = `${issuer}/.well-known/jwks.json`,
  ) {
    // jose's remote JWKS fetch defaults to the ambient global fetch, which on
    // this Node runtime is backed by a *different* undici instance than the
    // "undici" package this repo's tests use to mock the network boundary
    // (setGlobalDispatcher on one has no effect on the other) — pin jose to
    // the same undici fetch our tests actually intercept.
    this.jwks = createRemoteJWKSet(new URL(jwksUri), {
      // Same upstream typing gap as sigv4-fetch.ts's FetchLike: undici's
      // fetch is structurally the fetch jose expects, just declared against
      // a different (but compatible) Request/Response type import.
      [customFetch]: undiciFetch as unknown as typeof fetch,
    });
  }

  async verify(authorizationHeader: string | undefined): Promise<Result<ActorId, AuthenticationError>> {
    if (!authorizationHeader?.startsWith(BEARER_PREFIX)) {
      return err({ type: "MissingToken", message: "missing Bearer Authorization header" });
    }
    const token = authorizationHeader.slice(BEARER_PREFIX.length);

    try {
      // Cognito access tokens (the conventional bearer credential for API
      // calls) carry no `aud` claim at all — only ID tokens do. jose's
      // built-in `audience` check assumes `aud`, so it's verified manually
      // here against whichever of `client_id` (access token) or `aud` (ID
      // token) the token actually carries.
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer });
      const clientId = typeof payload.client_id === "string" ? payload.client_id : payload.aud;
      const audienceClaim = Array.isArray(clientId) ? clientId[0] : clientId;
      if (audienceClaim !== this.audience) {
        return err({ type: "InvalidToken", message: "token audience/client_id does not match" });
      }

      if (typeof payload.sub !== "string") {
        return err({ type: "InvalidToken", message: "token has no sub claim" });
      }

      const actorId = parseActorId(payload.sub);
      if (!actorId.ok) {
        return err({ type: "InvalidToken", message: actorId.error.message });
      }
      return ok(actorId.value);
    } catch (error) {
      return err({ type: "InvalidToken", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

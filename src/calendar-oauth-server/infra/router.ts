import { randomUUID } from "node:crypto";
import { signAccessToken, verifyAccessToken } from "./access-token";
import { verifyPkce } from "./pkce";
import { timingSafeStringEqual } from "./secure-compare";
import type { CalendarOAuthStore } from "./store";

// Every consent handshake in this mock (ADR-0003) grants access on behalf of
// the same single test user — there's no real login screen, so there's no
// real per-Caller identity for the mock authorization server to distinguish.
const MOCK_CALLER_SUB = "wayfarer-caller";

export type FunctionUrlEvent = {
  readonly rawPath: string;
  readonly rawQueryString: string;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: { readonly http: { readonly method: string } };
};

export type FunctionUrlResponse = {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
};

export type CalendarOAuthDeps = {
  readonly store: CalendarOAuthStore;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: Uint8Array;
  readonly issuer: string;
  // The AgentCore-registered callback URL — required, not optional: an
  // authorization server that accepts *any* redirect_uri is the classic
  // setup for authorization-code interception via a crafted link.
  readonly expectedRedirectUri: string;
};

// The mock OAuth2 authorization server fronting the calendar-events store
// (issue #17 / ADR-0003): a real authorization-code+PKCE flow and real
// signed tokens, registered with AgentCore Identity as a custom OAuth2
// vendor. Routes by method+path, mirroring booking-gateway's router Lambda.
export function createHandler(deps: CalendarOAuthDeps): (event: FunctionUrlEvent) => Promise<FunctionUrlResponse> {
  return async (event) => {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    if (method === "GET" && path === "/authorize") {
      return handleAuthorize(deps, new URLSearchParams(event.rawQueryString));
    }
    if (method === "POST" && path === "/token") {
      return handleToken(deps, parseFormBody(event), headerValue(event.headers, "authorization"));
    }
    if (method === "POST" && path === "/events") {
      return handleWriteEvent(deps, event.body, headerValue(event.headers, "authorization"));
    }
    if (method === "GET" && path === "/events") {
      return handleGetEvent(deps, new URLSearchParams(event.rawQueryString), headerValue(event.headers, "authorization"));
    }
    return jsonResponse(404, { error: "not found" });
  };
}

async function handleAuthorize(deps: CalendarOAuthDeps, query: URLSearchParams): Promise<FunctionUrlResponse> {
  const responseType = query.get("response_type");
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const codeChallenge = query.get("code_challenge");
  const codeChallengeMethod = query.get("code_challenge_method");
  const state = query.get("state") ?? "";

  if (responseType !== "code") {
    return jsonResponse(400, { error: "unsupported_response_type" });
  }
  if (clientId !== deps.clientId) {
    return jsonResponse(400, { error: "invalid_client" });
  }
  if (!redirectUri || redirectUri !== deps.expectedRedirectUri) {
    return jsonResponse(400, { error: "invalid_request", error_description: "invalid redirect_uri" });
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return jsonResponse(400, { error: "invalid_request", error_description: "S256 code_challenge is required" });
  }

  const code = randomUUID();
  await deps.store.putAuthorizationCode(code, { codeChallenge, redirectUri, clientId, sub: MOCK_CALLER_SUB });

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  location.searchParams.set("state", state);
  return { statusCode: 302, headers: { location: location.toString() }, body: "" };
}

async function handleToken(
  deps: CalendarOAuthDeps,
  form: URLSearchParams,
  authorizationHeader: string | undefined,
): Promise<FunctionUrlResponse> {
  const client = authenticateClient(deps, form, authorizationHeader);
  if (!client) {
    return jsonResponse(401, { error: "invalid_client" });
  }

  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(deps, form);
  }
  if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(deps, form);
  }
  return jsonResponse(400, { error: "unsupported_grant_type" });
}

async function handleAuthorizationCodeGrant(deps: CalendarOAuthDeps, form: URLSearchParams): Promise<FunctionUrlResponse> {
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const codeVerifier = form.get("code_verifier");
  if (!code || !redirectUri || !codeVerifier) {
    return jsonResponse(400, { error: "invalid_request" });
  }

  const record = await deps.store.takeAuthorizationCode(code);
  if (!record || record.redirectUri !== redirectUri || !verifyPkce(codeVerifier, record.codeChallenge)) {
    return jsonResponse(400, { error: "invalid_grant" });
  }

  return issueTokenResponse(deps, record.sub);
}

async function handleRefreshTokenGrant(deps: CalendarOAuthDeps, form: URLSearchParams): Promise<FunctionUrlResponse> {
  const refreshToken = form.get("refresh_token");
  if (!refreshToken) {
    return jsonResponse(400, { error: "invalid_request" });
  }

  const record = await deps.store.takeRefreshToken(refreshToken);
  if (!record) {
    return jsonResponse(400, { error: "invalid_grant" });
  }

  return issueTokenResponse(deps, record.sub);
}

async function issueTokenResponse(deps: CalendarOAuthDeps, sub: string): Promise<FunctionUrlResponse> {
  const accessToken = await signAccessToken(sub, deps.signingSecret, deps.issuer);
  const refreshToken = randomUUID();
  await deps.store.putRefreshToken(refreshToken, { sub });

  return jsonResponse(200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
  });
}

function authenticateClient(
  deps: CalendarOAuthDeps,
  form: URLSearchParams,
  authorizationHeader: string | undefined,
): { clientId: string } | undefined {
  const basic = authorizationHeader?.match(/^Basic (.+)$/);
  if (basic) {
    const [clientId, clientSecret] = Buffer.from(basic[1] ?? "", "base64").toString("utf8").split(":");
    return isValidClient(deps, clientId, clientSecret) ? { clientId: clientId ?? "" } : undefined;
  }

  const clientId = form.get("client_id");
  const clientSecret = form.get("client_secret");
  return isValidClient(deps, clientId, clientSecret) ? { clientId: clientId ?? "" } : undefined;
}

function isValidClient(
  deps: CalendarOAuthDeps,
  clientId: string | null | undefined,
  clientSecret: string | null | undefined,
): boolean {
  return clientId === deps.clientId && !!clientSecret && timingSafeStringEqual(clientSecret, deps.clientSecret);
}

async function handleWriteEvent(
  deps: CalendarOAuthDeps,
  rawBody: string | undefined,
  authorizationHeader: string | undefined,
): Promise<FunctionUrlResponse> {
  const sub = await authenticateBearer(deps, authorizationHeader);
  if (!sub) {
    return jsonResponse(401, { error: "invalid_token" });
  }

  const body = parseJsonBody(rawBody);
  const holdId = typeof body?.holdId === "string" ? body.holdId.trim() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!holdId || !title) {
    return jsonResponse(400, { error: "invalid_request", error_description: "holdId and title are required" });
  }

  const eventId = randomUUID();
  await deps.store.putEvent({ eventId, holdId, title, sub });
  return jsonResponse(200, { eventId, holdId, title });
}

async function handleGetEvent(
  deps: CalendarOAuthDeps,
  query: URLSearchParams,
  authorizationHeader: string | undefined,
): Promise<FunctionUrlResponse> {
  const sub = await authenticateBearer(deps, authorizationHeader);
  if (!sub) {
    return jsonResponse(401, { error: "invalid_token" });
  }

  const holdId = query.get("holdId");
  if (!holdId) {
    return jsonResponse(400, { error: "invalid_request" });
  }

  const record = await deps.store.getEvent(sub, holdId);
  if (!record) {
    return jsonResponse(404, { error: "not_found" });
  }
  return jsonResponse(200, { eventId: record.eventId, holdId: record.holdId, title: record.title });
}

async function authenticateBearer(deps: CalendarOAuthDeps, authorizationHeader: string | undefined): Promise<string | undefined> {
  const match = authorizationHeader?.match(/^Bearer (.+)$/);
  if (!match?.[1]) {
    return undefined;
  }
  return verifyAccessToken(match[1], deps.signingSecret, deps.issuer);
}

function headerValue(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function parseFormBody(event: FunctionUrlEvent): URLSearchParams {
  const raw = event.body ?? "";
  const decoded = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  return new URLSearchParams(decoded);
}

function parseJsonBody(rawBody: string | undefined): Record<string, unknown> | undefined {
  if (!rawBody) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jsonResponse(statusCode: number, body: unknown): FunctionUrlResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

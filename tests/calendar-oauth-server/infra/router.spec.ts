import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CalendarOAuthStore } from "../../../src/calendar-oauth-server/infra/store";
import { createHandler, type CalendarOAuthDeps, type FunctionUrlEvent } from "../../../src/calendar-oauth-server/infra/router";

const CLIENT_ID = "wayfarer-calendar-client";
const CLIENT_SECRET = "test-client-secret";
const SIGNING_SECRET = new TextEncoder().encode("test-signing-secret-at-least-32-bytes-long!!");
const ISSUER = "https://test-calendar-oauth.example.com";
const REDIRECT_URI = "https://agentcore.example.com/identities/oauth2/callback";
const CODE_VERIFIER = "a-code-verifier-that-is-at-least-43-characters-long";
const CODE_CHALLENGE = createHash("sha256").update(CODE_VERIFIER).digest("base64url");

// aws-sdk-client-mock is a stub, not a fake — it doesn't persist state
// between calls on its own, but the store's Put→Get→Delete sequence needs
// to actually round-trip within a test. Back it with a plain in-memory Map
// so the mocked DynamoDBDocumentClient behaves like a real (if tiny) table.
const dynamoMock = mockClient(DynamoDBDocumentClient);
let table: Map<string, Record<string, unknown>>;

function installInMemoryTable(): void {
  table = new Map();
  dynamoMock.on(PutCommand).callsFake((input) => {
    table.set(String(input.Item?.pk), input.Item as Record<string, unknown>);
    return {};
  });
  dynamoMock.on(GetCommand).callsFake((input) => ({ Item: table.get(String(input.Key?.pk)) }));
  // Mirrors CalendarOAuthStore's atomic conditional-delete-and-return —
  // a DeleteCommand with ConditionExpression: attribute_exists(pk) throws
  // when the item is already gone, same as real DynamoDB.
  dynamoMock.on(DeleteCommand).callsFake((input) => {
    const pk = String(input.Key?.pk);
    const item = table.get(pk);
    if (!item) {
      throw new ConditionalCheckFailedException({ message: "conditional check failed", $metadata: {} });
    }
    table.delete(pk);
    return { Attributes: item };
  });
}

function aDeps(): CalendarOAuthDeps {
  return {
    store: new CalendarOAuthStore("test-table", DynamoDBDocumentClient.from(new DynamoDBClient({}))),
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    signingSecret: SIGNING_SECRET,
    issuer: ISSUER,
    expectedRedirectUri: REDIRECT_URI,
  };
}

function aGetEvent(path: string, query: Record<string, string>, headers: Record<string, string> = {}): FunctionUrlEvent {
  return {
    rawPath: path,
    rawQueryString: new URLSearchParams(query).toString(),
    headers,
    requestContext: { http: { method: "GET" } },
  };
}

function anAuthorizeEvent(overrides: Record<string, string> = {}): FunctionUrlEvent {
  return aGetEvent("/authorize", {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "state-abc",
    ...overrides,
  });
}

function aTokenEvent(form: Record<string, string>): FunctionUrlEvent {
  return {
    rawPath: "/token",
    rawQueryString: "",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...form }).toString(),
    requestContext: { http: { method: "POST" } },
  };
}

function aWriteEventRequest(body: unknown, authorizationHeader: string): FunctionUrlEvent {
  return {
    rawPath: "/events",
    rawQueryString: "",
    headers: { authorization: authorizationHeader },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST" } },
  };
}

async function exchangeCodeForTokens(handler: ReturnType<typeof createHandler>, code: string) {
  return handler(
    aTokenEvent({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }),
  );
}

async function requestAuthorizationCode(handler: ReturnType<typeof createHandler>): Promise<string> {
  const response = await handler(anAuthorizeEvent());
  const location = new URL(response.headers?.location ?? "");
  const code = location.searchParams.get("code");
  if (!code) {
    throw new Error("test setup failed: /authorize did not return a code");
  }
  return code;
}

describe("calendar-oauth-server router", () => {
  beforeEach(() => {
    dynamoMock.reset();
    installInMemoryTable();
  });

  describe("GET /authorize", () => {
    it("redirects to redirect_uri with a code and the given state", async () => {
      const handler = createHandler(aDeps());

      const response = await handler(anAuthorizeEvent());

      expect(response.statusCode).toBe(302);
      const location = new URL(response.headers?.location ?? "");
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get("code")).toBeTruthy();
      expect(location.searchParams.get("state")).toBe("state-abc");
    });

    it("rejects an unrecognized client_id", async () => {
      const handler = createHandler(aDeps());

      const response = await handler(anAuthorizeEvent({ client_id: "someone-else" }));

      expect(response.statusCode).toBe(400);
    });

    it("rejects a non-S256 code_challenge_method", async () => {
      const handler = createHandler(aDeps());

      const response = await handler(anAuthorizeEvent({ code_challenge_method: "plain" }));

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /token — authorization_code grant", () => {
    it("issues a real signed access token and a refresh token for a valid code + verifier", async () => {
      const handler = createHandler(aDeps());
      const code = await requestAuthorizationCode(handler);

      const response = await exchangeCodeForTokens(handler, code);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { access_token: string; refresh_token: string; token_type: string };
      expect(body.token_type).toBe("Bearer");
      expect(typeof body.access_token).toBe("string");
      expect(typeof body.refresh_token).toBe("string");
    });

    it("rejects a mismatched code_verifier (PKCE failure)", async () => {
      const handler = createHandler(aDeps());
      const code = await requestAuthorizationCode(handler);

      const response = await handler(
        aTokenEvent({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: "wrong-verifier" }),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid_grant" });
    });

    it("rejects a reused authorization code (single-use)", async () => {
      const handler = createHandler(aDeps());
      const code = await requestAuthorizationCode(handler);
      await exchangeCodeForTokens(handler, code);

      const secondAttempt = await exchangeCodeForTokens(handler, code);

      expect(secondAttempt.statusCode).toBe(400);
    });

    it("rejects a mismatched redirect_uri", async () => {
      const handler = createHandler(aDeps());
      const code = await requestAuthorizationCode(handler);

      const response = await handler(
        aTokenEvent({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://not-the-registered-callback.example.com",
          code_verifier: CODE_VERIFIER,
        }),
      );

      expect(response.statusCode).toBe(400);
    });

    it("rejects invalid client credentials", async () => {
      const handler = createHandler(aDeps());
      const code = await requestAuthorizationCode(handler);

      const response = await handler(
        aTokenEvent({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
          client_secret: "wrong-secret",
        }),
      );

      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /token — refresh_token grant", () => {
    it("issues a new access token for a valid refresh token", async () => {
      const handler = createHandler(aDeps());
      const code = await requestAuthorizationCode(handler);
      const firstTokens = JSON.parse((await exchangeCodeForTokens(handler, code)).body) as { refresh_token: string };

      const response = await handler(aTokenEvent({ grant_type: "refresh_token", refresh_token: firstTokens.refresh_token }));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { access_token: string };
      expect(typeof body.access_token).toBe("string");
    });

    it("rejects an unrecognized or already-rotated refresh token", async () => {
      const handler = createHandler(aDeps());

      const response = await handler(aTokenEvent({ grant_type: "refresh_token", refresh_token: "not-a-real-token" }));

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid_grant" });
    });
  });

  describe("POST /events", () => {
    async function anAccessToken(handler: ReturnType<typeof createHandler>): Promise<string> {
      const code = await requestAuthorizationCode(handler);
      const tokens = JSON.parse((await exchangeCodeForTokens(handler, code)).body) as { access_token: string };
      return tokens.access_token;
    }

    it("writes an event given a valid Bearer token", async () => {
      const handler = createHandler(aDeps());
      const accessToken = await anAccessToken(handler);

      const response = await handler(
        aWriteEventRequest({ holdId: "hold-1", title: "Tokyo trip" }, `Bearer ${accessToken}`),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { holdId: string; title: string; eventId: string };
      expect(body).toMatchObject({ holdId: "hold-1", title: "Tokyo trip" });
      expect(typeof body.eventId).toBe("string");
    });

    it("rejects a request with no Bearer token", async () => {
      const handler = createHandler(aDeps());

      const response = await handler(aWriteEventRequest({ holdId: "hold-1", title: "Tokyo trip" }, ""));

      expect(response.statusCode).toBe(401);
    });

    it("rejects an expired access token", async () => {
      const handler = createHandler(aDeps());
      const expiredToken = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("wayfarer-caller")
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(SIGNING_SECRET);

      const response = await handler(
        aWriteEventRequest({ holdId: "hold-1", title: "Tokyo trip" }, `Bearer ${expiredToken}`),
      );

      expect(response.statusCode).toBe(401);
    });

    it("rejects a token signed with the wrong secret (invalid signature)", async () => {
      const handler = createHandler(aDeps());
      const badToken = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("wayfarer-caller")
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(new TextEncoder().encode("a-completely-different-secret-value!!!!"));

      const response = await handler(aWriteEventRequest({ holdId: "hold-1", title: "Tokyo trip" }, `Bearer ${badToken}`));

      expect(response.statusCode).toBe(401);
    });

    it("rejects a blank holdId or title", async () => {
      const handler = createHandler(aDeps());
      const accessToken = await anAccessToken(handler);

      const response = await handler(aWriteEventRequest({ holdId: "", title: "Tokyo trip" }, `Bearer ${accessToken}`));

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /events", () => {
    it("returns the event written for the Caller's holdId", async () => {
      const handler = createHandler(aDeps());
      const code = await requestAuthorizationCode(handler);
      const accessToken = (JSON.parse((await exchangeCodeForTokens(handler, code)).body) as { access_token: string })
        .access_token;
      await handler(aWriteEventRequest({ holdId: "hold-1", title: "Tokyo trip" }, `Bearer ${accessToken}`));

      const response = await handler(aGetEvent("/events", { holdId: "hold-1" }, { authorization: `Bearer ${accessToken}` }));

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ holdId: "hold-1", title: "Tokyo trip" });
    });

    it("returns 404 for a holdId with no written event", async () => {
      const handler = createHandler(aDeps());
      const accessToken = (
        JSON.parse((await exchangeCodeForTokens(handler, await requestAuthorizationCode(handler))).body) as {
          access_token: string;
        }
      ).access_token;

      const response = await handler(
        aGetEvent("/events", { holdId: "never-written" }, { authorization: `Bearer ${accessToken}` }),
      );

      expect(response.statusCode).toBe(404);
    });
  });
});

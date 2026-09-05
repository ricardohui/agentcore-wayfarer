import { createServer } from "node:http";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
} from "@aws-sdk/client-cognito-identity-provider";

const PORT = 8787;
const runtimeArn = process.env.RUNTIME_ARN;
const region = process.env.AWS_REGION ?? "us-east-1";
const cognitoClientId = process.env.COGNITO_CLIENT_ID;

if (!runtimeArn) {
  throw new Error(
    "RUNTIME_ARN not set — copy tools/concierge-ui/.env.example to .env and fill in the deployed Runtime ARN",
  );
}
if (!cognitoClientId) {
  throw new Error(
    "COGNITO_CLIENT_ID not set — copy tools/concierge-ui/.env.example to .env and fill in the deployed UserPoolClientId (issue #17)",
  );
}

// The Runtime's inbound authorizer is now a Cognito JWT authorizer (issue
// #17) — InvokeAgentRuntime can no longer be SigV4-signed via the SDK for
// this Runtime; AWS's own docs require a raw HTTPS call carrying the
// caller's bearer token instead (see "Authenticate and authorize with
// Inbound Auth and Outbound Auth" in the AgentCore devguide).
const invokeUrl = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=DEFAULT`;

const cognito = new CognitoIdentityProviderClient({ region });

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/login") {
    await handleLogin(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/invoke") {
    await handleInvoke(req, res);
    return;
  }
  res.writeHead(404).end();
});

async function handleLogin(req, res) {
  const body = await readJsonBody(
    req,
    (parsed) => typeof parsed.email === "string" && typeof parsed.password === "string",
    "expected { email: string, password: string }",
  );
  if (!body.ok) {
    sendJson(res, 400, { error: body.error });
    return;
  }
  const { email, password } = body.value;

  try {
    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: cognitoClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    const response = await cognito.send(command);
    const accessToken = response.AuthenticationResult?.AccessToken;
    if (!accessToken) {
      sendJson(res, 502, { error: "Cognito returned no access token" });
      return;
    }
    sendJson(res, 200, { accessToken });
  } catch (error) {
    const status = error instanceof NotAuthorizedException ? 401 : 502;
    console.error("InitiateAuth failed", error);
    sendJson(res, status, { error: error instanceof Error ? error.message : "login failed" });
  }
}

async function handleInvoke(req, res) {
  const authorizationHeader = req.headers.authorization;
  if (!authorizationHeader?.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "sign in first" });
    return;
  }

  const body = await readJsonBody(
    req,
    (parsed) => typeof parsed.message === "string" && typeof parsed.sessionId === "string",
    "expected { message: string, sessionId: string }",
  );
  if (!body.ok) {
    sendJson(res, 400, { error: body.error });
    return;
  }
  const { message, sessionId } = body.value;

  try {
    const response = await fetch(invokeUrl, {
      method: "POST",
      headers: {
        Authorization: authorizationHeader,
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      },
      body: JSON.stringify({ message }),
    });
    const reply = await response.text();
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? response.status : 502;
      sendJson(res, status, { error: reply || `invoke failed with status ${response.status}` });
      return;
    }
    sendJson(res, 200, { reply });
  } catch (error) {
    console.error("agent invoke failed", error);
    sendJson(res, 502, { error: error instanceof Error ? error.message : "invoke failed" });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

server.listen(PORT, () => {
  console.log(`Concierge UI proxy listening on http://localhost:${PORT}`);
});

function readJsonBody(req, isValid, expectedShapeMessage) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        if (!isValid(parsed)) {
          resolve({ ok: false, error: expectedShapeMessage });
          return;
        }
        resolve({ ok: true, value: parsed });
      } catch {
        resolve({ ok: false, error: "invalid JSON body" });
      }
    });
  });
}

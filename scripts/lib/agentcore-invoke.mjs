// Shared by every scenario-driving ops script (run-evaluation-scenarios.mjs,
// continue-scenario-session.mjs): sign in as the Cognito test user and POST
// one message to the deployed Concierge Runtime's /invocations entry point.
// Mirrors tools/concierge-ui/proxy/server.mjs's sign-in + invoke pattern
// (issue #17), factored out once a second script needed the same logic
// rather than left duplicated between the two.
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

// The test user's password is generated (Secrets Manager, identity-construct.ts)
// and is fetched here only to build a Cognito Authorization header in-process -
// it is never logged or returned from this function.
export async function signIn({ region, cognitoClientId, testUserPasswordSecretArn, testUserEmail }) {
  const secrets = new SecretsManagerClient({ region });
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: testUserPasswordSecretArn }));
  const password = secret.SecretString;
  if (!password) {
    throw new Error("TestUserPasswordSecret returned no SecretString");
  }

  const cognito = new CognitoIdentityProviderClient({ region });
  const auth = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: cognitoClientId,
      AuthParameters: { USERNAME: testUserEmail, PASSWORD: password },
    }),
  );
  const accessToken = auth.AuthenticationResult?.AccessToken;
  if (!accessToken) {
    throw new Error("Cognito InitiateAuth returned no access token");
  }
  return accessToken;
}

export async function invoke({ region, runtimeArn, accessToken, sessionId, message }) {
  const invokeUrl = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=DEFAULT`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(invokeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`invoke failed with status ${response.status}: ${body}`);
    }
    try {
      const parsed = JSON.parse(body);
      return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      return body;
    }
  } finally {
    clearTimeout(timeout);
  }
}

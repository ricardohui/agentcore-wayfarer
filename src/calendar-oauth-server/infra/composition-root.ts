import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { CalendarOAuthDeps } from "./router";
import { CalendarOAuthStore } from "./store";

export async function buildCalendarOAuthDeps(): Promise<CalendarOAuthDeps> {
  const secretsClient = new SecretsManagerClient({});
  const [clientSecret, signingSecret] = await Promise.all([
    getSecretString(secretsClient, requireEnv("CLIENT_SECRET_ARN")),
    getSecretString(secretsClient, requireEnv("SIGNING_SECRET_ARN")),
  ]);

  return {
    store: new CalendarOAuthStore(requireEnv("TABLE_NAME")),
    clientId: requireEnv("CLIENT_ID"),
    clientSecret,
    signingSecret: new TextEncoder().encode(signingSecret),
    issuer: requireEnv("ISSUER"),
    expectedRedirectUri: requireEnv("EXPECTED_REDIRECT_URI"),
  };
}

async function getSecretString(client: SecretsManagerClient, secretArn: string): Promise<string> {
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error(`secret ${secretArn} has no SecretString`);
  }
  return response.SecretString;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

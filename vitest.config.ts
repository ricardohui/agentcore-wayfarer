import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    env: {
      // Composition-root default for tests that never actually call the
      // Gateway adapter (it's constructed eagerly at module load, but the
      // acceptance harness only mocks the network boundaries it exercises).
      GATEWAY_URL: "https://test-gateway.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      // Composition-root default for the Memory adapter (issue #16) — like
      // GATEWAY_URL above, only exercised where a test mocks its network boundary.
      MEMORY_ID: "test-memory-id",
      // SigV4 signing needs *some* resolvable credentials to compute a
      // signature — these never reach a real AWS endpoint in tests.
      AWS_ACCESS_KEY_ID: "test-access-key-id",
      AWS_SECRET_ACCESS_KEY: "test-secret-access-key",
      // Inbound auth (issue #17) — composition-root default for the
      // CognitoJwtVerifier, matched by tests/concierge/support/cognito-network-boundary.ts.
      COGNITO_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool",
      COGNITO_CLIENT_ID: "test-client-id",
      // Identity's Delegated credential (issue #17) — composition-root default
      // for the DelegatedCalendarAdapter, only exercised where a test mocks
      // its network boundary.
      CALENDAR_CREDENTIAL_PROVIDER_NAME: "wayfarer-calendar-oauth2",
      CALENDAR_API_URL: "https://test-calendar.example.com",
      // Code Interpreter's budget/currency math (issue #18) — composition-root
      // default for the CodeInterpreterBudgetAdapter, only exercised where a
      // test mocks its network boundary.
      CODE_INTERPRETER_ID: "test-code-interpreter-id",
    },
  },
});

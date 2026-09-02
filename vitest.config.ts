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
    },
  },
});

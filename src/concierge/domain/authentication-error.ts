// Inbound auth (issue #17): AgentCore Runtime's platform-level JWT authorizer
// rejects a missing/invalid token before the Concierge's own code ever runs
// in production, but the local invocation server (bedrock-agentcore's
// BedrockAgentCoreApp) has no such platform layer — the handler verifies the
// Authorization header itself, both as defense-in-depth and as the layer this
// repo's acceptance tests can actually exercise.
export type AuthenticationError =
  | { readonly type: "MissingToken"; readonly message: string }
  | { readonly type: "InvalidToken"; readonly message: string };

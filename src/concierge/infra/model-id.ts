// Single source of truth for which Bedrock model the Concierge talks to —
// imported by both the composition root (runtime default) and the CDK stack
// (deployed env var + IAM grant), so the two can't drift apart.
export const CONCIERGE_MODEL_ID = "openai.gpt-oss-120b-1:0";

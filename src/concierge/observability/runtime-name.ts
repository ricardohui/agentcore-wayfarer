// Single source of truth for the Concierge's Runtime name — imported by
// both the CDK stack (runtimeName: prop) and the observability module,
// which needs it to discover its own CloudWatch log group at runtime
// (issue #23's split-telemetry event-record pipeline, ADR-0007's Revision 3):
// AgentCore assigns the log group's full name
// (/aws/bedrock-agentcore/runtimes/<agentRuntimeId>-DEFAULT) only after the
// Runtime resource exists, and referencing that generated id from a policy
// or environment variable on the Runtime's own resource is a circular
// CloudFormation dependency — so the Concierge discovers its log group by
// prefix-searching on this known, fixed name instead.
export const CONCIERGE_RUNTIME_NAME = "wayfarer_concierge";

// Single source of truth for the Knowledge Base's Gateway target name and its
// connector-defined tool operation (issue #21 / ADR-0009) — imported by both
// the CDK stack (target provisioning) and the Concierge's
// KnowledgeBaseGatewayAdapter (MCP tool-name prefix,
// "{targetName}___{operation}" per AgentCore Gateway's tool naming
// convention), so the two can't drift apart.
//
// Unlike booking-gateway/gateway-target-name.ts's operation names (this
// repo's own router Lambda contract), RETRIEVE_OPERATION_NAME is fixed by
// AWS's built-in `bedrock-knowledge-bases` connector, not authored here.
export const DESTINATION_GUIDES_GATEWAY_TARGET_NAME = "destination-guides";
export const RETRIEVE_OPERATION_NAME = "Retrieve";

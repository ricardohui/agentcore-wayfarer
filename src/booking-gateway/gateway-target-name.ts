// Single source of truth for the Gateway target's name — imported by the CDK
// stack (target provisioning) and the Concierge's BookingGatewayAdapter (MCP
// tool-name prefix, "{targetName}___{operation}" per AgentCore Gateway's tool
// naming convention), so the two can't drift apart.
export const BOOKING_GATEWAY_TARGET_NAME = "booking";

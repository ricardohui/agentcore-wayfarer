import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import {
  DESTINATION_GUIDES_GATEWAY_TARGET_NAME,
  RETRIEVE_OPERATION_NAME,
} from "../../../src/destination-guides/gateway-target-name";

export type KnowledgeBaseGatewayTargetProps = {
  readonly gateway: agentcore.CfnGateway;
  readonly gatewayRole: iam.Role;
  readonly policyEngine: agentcore.CfnPolicyEngine;
  readonly knowledgeBaseId: string;
  // Ordered after the booking target's own CreateGatewayTarget call — this
  // Gateway's own history (see booking-gateway-construct.ts's Policy-engine
  // and per-policy dependency comments) shows CloudFormation needs explicit
  // ordering around this Gateway's registration calls; nothing here
  // guarantees AWS's Gateway API tolerates two concurrent
  // CreateGatewayTarget calls against the same Gateway's tool-schema
  // registry.
  readonly bookingGatewayTarget: agentcore.CfnGatewayTarget;
};

// The Knowledge Base's Gateway target (issue #21 / ADR-0009): a second,
// distinct target on the same booking Gateway (ADR-0001/#15), using
// AgentCore's native `bedrock-knowledge-bases` connector rather than a
// Lambda/OpenAPI target — no router code of our own to write. Only the
// `Retrieve` tool is configured (not `AgenticRetrieveStream`): issue #21
// asks for a single retrieve tool, not multi-step agentic planning.
export class KnowledgeBaseGatewayTargetConstruct extends cdk.Resource {
  public readonly gatewayTarget: agentcore.CfnGatewayTarget;

  constructor(scope: Construct, id: string, props: KnowledgeBaseGatewayTargetProps) {
    super(scope, id);

    // The connector uses the Gateway's own execution role (gatewayRole),
    // not a per-target credential provider — per AWS's docs, this connector
    // supports only the GATEWAY_IAM_ROLE credential provider type. Scoped to
    // this one Knowledge Base; bedrock:AgenticRetrieveStream is omitted since
    // only the Retrieve tool is configured below.
    const knowledgeBaseArn = cdk.Stack.of(this).formatArn({
      service: "bedrock",
      resource: "knowledge-base",
      resourceName: props.knowledgeBaseId,
    });
    const gatewayKnowledgeBaseAccess = new iam.Policy(this, "GatewayKnowledgeBaseAccess", {
      statements: [
        new iam.PolicyStatement({
          actions: ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
          resources: [knowledgeBaseArn],
        }),
      ],
    });
    props.gatewayRole.attachInlinePolicy(gatewayKnowledgeBaseAccess);

    this.gatewayTarget = new agentcore.CfnGatewayTarget(this, "GatewayTarget", {
      gatewayIdentifier: props.gateway.attrGatewayIdentifier,
      name: DESTINATION_GUIDES_GATEWAY_TARGET_NAME,
      description: "Destination-guide retrieval backed by the Managed Knowledge Base (issue #21 / ADR-0009)",
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: "bedrock-knowledge-bases" },
            configurations: [
              {
                name: RETRIEVE_OPERATION_NAME,
                parameterValues: { knowledgeBaseId: props.knowledgeBaseId },
              },
            ],
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    });
    // Serializes this target's creation after the booking target's own —
    // see the props field's comment above.
    this.gatewayTarget.node.addDependency(props.bookingGatewayTarget);
    // Gateway's CreateGatewayTarget validation (a GetKnowledgeBase check,
    // ~30s after creation) needs the IAM policy above already attached —
    // no implicit CFN ordering exists between an IAM::Policy and a target
    // that doesn't reference it directly, same reasoning as
    // booking-gateway-construct.ts's gatewayPolicyEngineAccess dependency.
    this.gatewayTarget.node.addDependency(gatewayKnowledgeBaseAccess);

    // Unconditional permit, same treatment as booking's SearchPolicy
    // (read-only, no Policy consequence, issue #21's own "no Policy rule
    // should touch this tool" acceptance criterion) — the Policy engine
    // denies by default in ENFORCE mode, so this is what keeps `retrieve`
    // callable at all once the engine is attached to the shared Gateway.
    const retrieveAction = `AgentCore::Action::"${DESTINATION_GUIDES_GATEWAY_TARGET_NAME}___${RETRIEVE_OPERATION_NAME}"`;
    const gatewayResource = `resource == AgentCore::Gateway::"${props.gateway.attrGatewayArn}"`;
    const retrievePolicy = new agentcore.CfnPolicy(this, "RetrievePolicy", {
      policyEngineId: props.policyEngine.attrPolicyEngineId,
      name: "wayfarer_destination_guides_unrestricted",
      description: "Unconditionally permits the destination-guide retrieve tool - read-only, no Policy consequence",
      validationMode: "IGNORE_ALL_FINDINGS",
      definition: {
        cedar: {
          statement: `permit(
  principal,
  action == ${retrieveAction},
  ${gatewayResource}
);`,
        },
      },
    });
    // Same reasoning as booking-gateway-construct.ts's per-policy
    // dependency: the Policy engine only recognizes this action once
    // GatewayTarget has registered its tool schema.
    retrievePolicy.node.addDependency(this.gatewayTarget);
  }
}

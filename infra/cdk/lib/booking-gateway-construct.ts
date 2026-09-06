import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { BOOKING_GATEWAY_TARGET_NAME } from "../../../src/booking-gateway/gateway-target-name";
import { HOLD_APPROVAL_THRESHOLD_LOCAL_AMOUNT } from "../../../src/booking-gateway/hold-approval-threshold";
import { BOOKING_TOOL_DEFINITIONS } from "../../../src/booking-gateway/tool-catalog";

function bookingAction(toolName: string): string {
  return `AgentCore::Action::"${BOOKING_GATEWAY_TARGET_NAME}___${toolName}"`;
}

// How far back the one-time-consumption temporal policy looks for an
// unconsumed approve-hold event (issue #20 / ADR-0006) — generous relative
// to a single planning conversation, since Policy sessions carry at most a
// 24h look-back window regardless.
const APPROVAL_LOOKBACK_WINDOW = "24h";

const ROUTER_LAMBDA_BUNDLE_DIR = path.join(__dirname, "../../../dist/booking-gateway");

// Gateway's ToolDefinition shape is a structural match for
// BOOKING_TOOL_DEFINITIONS's inputSchema (type/properties/required) — no
// translation needed beyond satisfying the CFN property type.
const GATEWAY_TOOL_SCHEMA: agentcore.CfnGatewayTarget.ToolDefinitionProperty[] = BOOKING_TOOL_DEFINITIONS.map(
  (definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: { ...definition.inputSchema, required: [...definition.inputSchema.required] },
  }),
);

// Gateway's booking target (issue #15): one router Lambda behind one Gateway
// target. ADR-0001 calls for "lambda_iam auth, no credential provider" —
// implemented here as CFN's mcp.lambda target type (Gateway invokes the
// Lambda ARN directly under its own IAM role via a ToolDefinition schema),
// rather than an mcp.openApiSchema target fronting a signed HTTP backend —
// both satisfy "lambda_iam, no credential provider" per AWS's docs, and
// mcp.lambda needs no Function URL/SigV4-to-Lambda plumbing to get there.
export class BookingGatewayConstruct extends cdk.Resource {
  public readonly gateway: agentcore.CfnGateway;
  public readonly routerLambda: lambda.Function;
  public readonly policyEngine: agentcore.CfnPolicyEngine;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.routerLambda = new lambda.Function(this, "RouterLambda", {
      functionName: "wayfarer-booking-router",
      description:
        "Wayfarer booking Gateway mock router (issue #15) - search-flights/search-hotels/hold-flight/hold-hotel",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "app.handler",
      code: lambda.Code.fromAsset(ROUTER_LAMBDA_BUNDLE_DIR),
      timeout: cdk.Duration.seconds(10),
    });

    const gatewayRole = new iam.Role(this, "GatewayRole", {
      description: "Wayfarer booking Gateway's service role - invokes the mock router Lambda",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": cdk.Stack.of(this).account },
          ArnLike: {
            "aws:SourceArn": cdk.Stack.of(this).formatArn({
              service: "bedrock-agentcore",
              resource: "gateway",
              resourceName: "*",
            }),
          },
        },
      }),
    });
    this.routerLambda.grantInvoke(gatewayRole);

    this.gateway = new agentcore.CfnGateway(this, "Gateway", {
      name: "wayfarer-booking-gateway",
      description: "Wayfarer booking Gateway - search and hold (issue #15)",
      roleArn: gatewayRole.roleArn,
      authorizerType: "AWS_IAM",
      protocolType: "MCP",
    });

    new agentcore.CfnGatewayTarget(this, "GatewayTarget", {
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      name: BOOKING_GATEWAY_TARGET_NAME,
      description: "Booking search+hold tools backed by the mock router Lambda",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: this.routerLambda.functionArn,
            toolSchema: { inlinePayload: GATEWAY_TOOL_SCHEMA },
          },
        },
      },
      // Required for every mcp.lambda/openApiSchema/smithyModel target, even
      // though "lambda_iam" needs no separate credential provider — this is
      // what tells Gateway to sign the Lambda invoke with its own role
      // rather than looking up a stored credential.
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    });

    // Policy (issue #20 / ADR-0006): gates hold-flight/hold-hotel above a
    // flat Local-currency threshold behind an unconsumed approve-hold event.
    this.policyEngine = new agentcore.CfnPolicyEngine(this, "PolicyEngine", {
      name: "wayfarer_booking_policy_engine",
      description: "Wayfarer booking Policy - Gated-hold approval gate (issue #20 / ADR-0006)",
    });

    this.gateway.policyEngineConfiguration = {
      arn: this.policyEngine.attrPolicyEngineArn,
      mode: "ENFORCE",
    };

    const holdActions = [bookingAction("hold-flight"), bookingAction("hold-hotel")].join(", ");
    const gatewayResource = `resource == AgentCore::Gateway::"${this.gateway.attrGatewayArn}"`;

    // The Policy engine denies by default: attaching it in ENFORCE mode
    // gates every action on the Gateway, not just the ones a policy
    // targets. search-flights/search-hotels carry no gating decision of
    // their own (CONTEXT.md: only hold-flight/hold-hotel are Gated) — this
    // unconditional permit is what keeps them working at all once the
    // engine is attached.
    new agentcore.CfnPolicy(this, "SearchPolicy", {
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      name: "wayfarer_search_unrestricted",
      description: "Unconditionally permits search-flights/search-hotels - read-only, no Policy consequence",
      validationMode: "FAIL_ON_ANY_FINDINGS",
      definition: {
        cedar: {
          statement: `permit(
  principal,
  action in [${bookingAction("search-flights")}, ${bookingAction("search-hotels")}],
  ${gatewayResource}
);`,
        },
      },
    });

    // NL-generated via `agentcore add policy --generate "Only allow flight
    // and hotel holds priced at 500 or less"` (ADR-0006) — permits any hold
    // at or under the flat threshold with no approval step.
    new agentcore.CfnPolicy(this, "HoldThresholdPolicy", {
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      name: "wayfarer_hold_threshold",
      description: "Permits hold-flight/hold-hotel at or under the flat Local-currency threshold",
      validationMode: "FAIL_ON_ANY_FINDINGS",
      definition: {
        cedar: {
          statement: `permit(
  principal,
  action in [${holdActions}],
  ${gatewayResource}
) when {
  context.input.price <= ${HOLD_APPROVAL_THRESHOLD_LOCAL_AMOUNT}
};`,
        },
      },
    });

    // Hand-written Cedar: approve-hold carries no threshold of its own -
    // always permitted so its response is recorded as an approval event for
    // the temporal policy below to match against.
    new agentcore.CfnPolicy(this, "ApproveHoldPolicy", {
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      name: "wayfarer_approve_hold",
      description: "Unconditionally permits approve-hold so its response is recorded as an approval event",
      validationMode: "FAIL_ON_ANY_FINDINGS",
      definition: {
        cedar: {
          statement: `permit(
  principal,
  action == ${bookingAction("approve-hold")},
  ${gatewayResource}
);`,
        },
      },
    });

    // Hand-written Dogwood temporal policy (ADR-0006: AWS's own reference
    // examples hand-write temporal conditions rather than generate them): a
    // hold above the threshold is permitted only once per unconsumed
    // approve-hold event — consumed by either hold type, so a second,
    // unrelated hold attempt cannot reuse it. approve-hold carries no price
    // of its own (ADR-0006: "no other side effect"), so this consumption
    // isn't scoped to the specific price that prompted the approval
    // request — any single hold up to the approval's lookback window
    // consumes it, not necessarily the one the Caller actually saw. Binding
    // the approval to a specific price would mean threading it through
    // approve-hold's input and correlating it in this predicate (as the
    // "output-to-input integrity" pattern does) — deliberately out of scope
    // for this ticket's generic, unparameterized approve-hold action.
    new agentcore.CfnPolicy(this, "HoldApprovalConsumptionPolicy", {
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      name: "wayfarer_hold_approval_consumption",
      description: "Permits a Gated hold once per unconsumed approve-hold event (one-time consumption)",
      validationMode: "FAIL_ON_ANY_FINDINGS",
      definition: {
        policy: {
          statement: `permit(
  principal,
  action in [${holdActions}],
  ${gatewayResource}
)
when temporal {
  !${bookingAction("hold-flight")}::response{ eventResource: resource }
  since within ${APPROVAL_LOOKBACK_WINDOW} ${bookingAction("approve-hold")}::response{ eventResource: resource }
  &&
  !${bookingAction("hold-hotel")}::response{ eventResource: resource }
  since within ${APPROVAL_LOOKBACK_WINDOW} ${bookingAction("approve-hold")}::response{ eventResource: resource }
};`,
        },
      },
    });
  }
}

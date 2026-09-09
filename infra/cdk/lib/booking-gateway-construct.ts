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
  public readonly gatewayRole: iam.Role;
  public readonly bookingGatewayTarget: agentcore.CfnGatewayTarget;

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

    this.gatewayRole = new iam.Role(this, "GatewayRole", {
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
    this.routerLambda.grantInvoke(this.gatewayRole);

    this.gateway = new agentcore.CfnGateway(this, "Gateway", {
      name: "wayfarer-booking-gateway",
      description: "Wayfarer booking Gateway - search and hold (issue #15)",
      roleArn: this.gatewayRole.roleArn,
      authorizerType: "AWS_IAM",
      protocolType: "MCP",
    });

    this.bookingGatewayTarget = new agentcore.CfnGatewayTarget(this, "GatewayTarget", {
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

    // Gateway's own control plane (via its GenesisPolicyEngineCheck
    // assumed-role session) needs GetPolicyEngine to read the Policy
    // engine's definition when attaching policyEngineConfiguration below,
    // plus AuthorizeAction and PartiallyAuthorizeActions on both the Policy
    // engine and the Gateway to make the ALLOW/DENY call on every
    // subsequent Gateway request (Cedar's "resource ==
    // AgentCore::Gateway::..." clause makes the Gateway ARN itself part of
    // the resource under evaluation, not just the engine) - per AWS's own
    // CDK reference example for wiring a Policy engine to a Gateway. CFN
    // has no implicit ordering between the Gateway resource and this
    // policy statement (neither's properties reference the other), so
    // without the explicit dependency below CloudFormation may attach the
    // policy engine to the Gateway before the role's inline policy update
    // actually lands.
    const gatewayPolicyEngineAccess = new iam.Policy(this, "GatewayPolicyEngineAccess", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "bedrock-agentcore:GetPolicyEngine",
            "bedrock-agentcore:AuthorizeAction",
            "bedrock-agentcore:PartiallyAuthorizeActions",
          ],
          resources: [this.policyEngine.attrPolicyEngineArn],
        }),
        // A literal wildcard-suffixed ARN, not a Fn::GetAtt off `this.gateway`
        // - referencing the Gateway's own attribute here would make this
        // Policy implicitly depend on it, conflicting with the explicit
        // Gateway-depends-on-Policy edge below (a circular dependency CFN
        // rejects outright). Only one Gateway exists in this stack, so the
        // wildcard costs nothing in practice.
        new iam.PolicyStatement({
          actions: ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
          resources: [
            cdk.Stack.of(this).formatArn({ service: "bedrock-agentcore", resource: "gateway", resourceName: "*" }),
          ],
        }),
      ],
    });
    this.gatewayRole.attachInlinePolicy(gatewayPolicyEngineAccess);
    this.gateway.node.addDependency(gatewayPolicyEngineAccess);

    const holdActions = [bookingAction("hold-flight"), bookingAction("hold-hotel")].join(", ");
    const gatewayResource = `resource == AgentCore::Gateway::"${this.gateway.attrGatewayArn}"`;

    // The Policy engine denies by default: attaching it in ENFORCE mode
    // gates every action on the Gateway, not just the ones a policy
    // targets. search-flights/search-hotels carry no gating decision of
    // their own (CONTEXT.md: only hold-flight/hold-hotel are Gated) — this
    // unconditional permit is what keeps them working at all once the
    // engine is attached. Cedar's analyzer flags any unconditional,
    // unrestricted-principal permit as "Overly Permissive" - here that's
    // the deliberate design (read-only, no Policy consequence), so
    // IGNORE_ALL_FINDINGS is used instead of failing the deploy on an
    // expected finding.
    const searchPolicy = new agentcore.CfnPolicy(this, "SearchPolicy", {
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      name: "wayfarer_search_unrestricted",
      description: "Unconditionally permits search-flights/search-hotels - read-only, no Policy consequence",
      validationMode: "IGNORE_ALL_FINDINGS",
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
    // at or under the flat threshold with no approval step. `price` is a
    // JSON Schema "number" (tool-catalog.ts) - AgentCore's generated Cedar
    // schema maps that to `decimal`, not `Long`, and Cedar's `<=` only
    // accepts `Long`; decimal needs the `decimal("...")` extension
    // constructor and its `.lessThanOrEqual(...)` method instead. `price`
    // is also absent from hold-flight/hold-hotel's `required` array, so
    // it's optional in the schema - Cedar's static analyzer refuses to
    // read an optional attribute without a `has` presence guard first.
    const holdThresholdPolicy = new agentcore.CfnPolicy(this, "HoldThresholdPolicy", {
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
  context.input has price &&
  context.input.price.lessThanOrEqual(decimal("${HOLD_APPROVAL_THRESHOLD_LOCAL_AMOUNT}.0000"))
};`,
        },
      },
    });

    // Hand-written Cedar: approve-hold carries no threshold of its own -
    // always permitted. Same deliberate "Overly Permissive" finding as
    // SearchPolicy above, and the same IGNORE_ALL_FINDINGS reason.
    // approve-hold no longer feeds a Policy rule directly (ADR-0006,
    // revised) - BookingToolExecutor marks its own session approved when
    // this call succeeds, and stamps the next hold with `approved: true`
    // for HoldApprovedPolicy below to match. approve-hold stays a real
    // Gateway action regardless: an explicit, traceable approval event,
    // useful for the Observability ticket (#21).
    const approveHoldPolicy = new agentcore.CfnPolicy(this, "ApproveHoldPolicy", {
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      name: "wayfarer_approve_hold",
      description: "Unconditionally permits approve-hold so its response is recorded as an approval event",
      validationMode: "IGNORE_ALL_FINDINGS",
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

    // Hand-written Cedar (ADR-0006, revised): a hold above the threshold is
    // also permitted when the request itself carries `approved: true`. This
    // replaces a Dogwood temporal one-time-consumption rule that hit an AWS
    // platform bug on first live deploy — once any Dogwood policy is
    // attached to a Policy engine, every action that reaches full
    // evaluation fails with a generic internal error, independent of which
    // Cedar policy governs it or its validationMode (see issue #20's
    // finding). This rule is stateless and per-request by design: it has no
    // opinion on whether the approval was already spent. One-time
    // consumption instead lives in BookingToolExecutor, which tracks each
    // session's unconsumed approval and only sets `approved: true` on the
    // one hold call that follows an approve-hold success.
    const holdApprovedPolicy = new agentcore.CfnPolicy(this, "HoldApprovedPolicy", {
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      name: "wayfarer_hold_approved",
      description: "Permits hold-flight/hold-hotel when the request carries the Caller's approval",
      validationMode: "FAIL_ON_ANY_FINDINGS",
      definition: {
        cedar: {
          statement: `permit(
  principal,
  action in [${holdActions}],
  ${gatewayResource}
) when {
  context.input has approved &&
  context.input.approved
};`,
        },
      },
    });

    // Every policy's Cedar statement names an action from
    // BOOKING_TOOL_DEFINITIONS (search-flights, hold-flight, approve-hold,
    // ...) - the Policy engine only recognizes those names once
    // GatewayTarget has registered its tool schema. Neither a Policy's
    // properties nor the Target's reference each other, so CFN has no
    // implicit ordering; without this explicit dependency a Policy can be
    // created before its Target update lands, failing validation with
    // "unrecognized action ... did you mean ...?".
    for (const policy of [searchPolicy, holdThresholdPolicy, approveHoldPolicy, holdApprovedPolicy]) {
      policy.node.addDependency(this.bookingGatewayTarget);
    }
  }
}

import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { BOOKING_GATEWAY_TARGET_NAME } from "../../../src/booking-gateway/gateway-target-name";
import { BOOKING_TOOL_DEFINITIONS } from "../../../src/booking-gateway/tool-catalog";

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
  }
}

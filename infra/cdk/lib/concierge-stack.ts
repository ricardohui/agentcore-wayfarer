import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { CONCIERGE_MODEL_ID } from "../../../src/concierge/infra/model-id";
import { BookingGatewayConstruct } from "./booking-gateway-construct";

const HANDLER_BUNDLE_DIR = path.join(__dirname, "../../../dist/concierge");

export class ConciergeStack extends cdk.Stack {
  public readonly runtime: agentcore.Runtime;
  public readonly bookingGateway: BookingGatewayConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bookingGateway = new BookingGatewayConstruct(this, "BookingGateway");

    const agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromCodeAsset({
      path: HANDLER_BUNDLE_DIR,
      runtime: agentcore.AgentCoreRuntime.NODE_22,
      entrypoint: ["app.js"],
    });

    this.runtime = new agentcore.Runtime(this, "ConciergeRuntime", {
      runtimeName: "wayfarer_concierge",
      description: "Wayfarer Concierge - Runtime walking skeleton (issue #14)",
      agentRuntimeArtifact,
      environmentVariables: {
        CONCIERGE_MODEL_ID,
        AWS_REGION: this.region,
        GATEWAY_URL: this.bookingGateway.gateway.attrGatewayUrl,
      },
    });

    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}::foundation-model/${CONCIERGE_MODEL_ID}`,
        ],
      }),
    );
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [this.bookingGateway.gateway.attrGatewayArn],
      }),
    );

    new cdk.CfnOutput(this, "RuntimeArn", { value: this.runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, "RuntimeId", { value: this.runtime.agentRuntimeId });
    new cdk.CfnOutput(this, "GatewayUrl", { value: this.bookingGateway.gateway.attrGatewayUrl });
  }
}

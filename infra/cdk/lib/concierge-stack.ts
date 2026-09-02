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
  public readonly memory: agentcore.Memory;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bookingGateway = new BookingGatewayConstruct(this, "BookingGateway");

    // Long-term Strategies (issue #16): user-preference for stable facts
    // (home airport, seat/dietary prefs), semantic for soft free-form ones
    // (e.g. "avoids red-eyes") — namespaces fixed to match memory-namespaces.ts
    // so the adapter's RetrieveMemoryRecords calls actually hit what these
    // Strategies write to.
    this.memory = new agentcore.Memory(this, "Memory", {
      memoryName: "wayfarer_concierge_memory",
      description: "Wayfarer Concierge memory - scratch state + long-term preferences (issue #16)",
      memoryStrategies: [
        agentcore.MemoryStrategy.usingUserPreference({
          strategyName: "wayfarer_user_preference",
          description: "Stable Caller facts: home airport, seat/dietary preferences",
          namespaces: ["/actor/{actorId}/preferences"],
        }),
        agentcore.MemoryStrategy.usingSemantic({
          strategyName: "wayfarer_semantic_preference",
          description: "Soft free-form Caller preferences mentioned in conversation",
          namespaces: ["/actor/{actorId}/semantic"],
        }),
      ],
    });

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
        MEMORY_ID: this.memory.memoryId,
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
    this.memory.grantWrite(this.runtime.role);
    this.memory.grantReadShortTermMemory(this.runtime.role);
    this.memory.grantReadLongTermMemory(this.runtime.role);

    new cdk.CfnOutput(this, "RuntimeArn", { value: this.runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, "RuntimeId", { value: this.runtime.agentRuntimeId });
    new cdk.CfnOutput(this, "GatewayUrl", { value: this.bookingGateway.gateway.attrGatewayUrl });
    new cdk.CfnOutput(this, "MemoryId", { value: this.memory.memoryId });
  }
}

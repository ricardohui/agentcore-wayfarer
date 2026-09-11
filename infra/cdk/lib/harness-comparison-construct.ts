import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { HARNESS_NAME } from "../../../src/harness-comparison/harness-name";
import { HARNESS_DEFAULT_MODEL_ID } from "../../../src/harness-comparison/model-id";
import { HARNESS_SYSTEM_PROMPT } from "../../../src/harness-comparison/system-prompt";
import { confusedDeputyTrustPrincipal } from "./confused-deputy-trust-principal";

export type HarnessComparisonConstructProps = {
  // The already-deployed booking Gateway's ARN (ConciergeStack's own
  // "GatewayArn" output) — this construct never references ConciergeStack's
  // CDK constructs directly, matching issue #22's "no shared runtime path".
  readonly gatewayArn: string;
};

// Harness's standalone comparison build (issue #22 / ADR-0002): the same
// 3-city search+hold beat as Gateway (issue #15), reimplemented as pure
// declarative Harness config — no orchestration code, no container. Never
// referenced by ConciergeStack or its deployment.
export class HarnessComparisonConstruct extends cdk.Resource {
  public readonly executionRole: iam.Role;
  public readonly harness: agentcore.CfnHarness;

  constructor(scope: Construct, id: string, props: HarnessComparisonConstructProps) {
    super(scope, id);

    this.executionRole = new iam.Role(this, "ExecutionRole", {
      description: "Wayfarer Harness comparison build's execution role (issue #22)",
      assumedBy: confusedDeputyTrustPrincipal(this, "bedrock-agentcore.amazonaws.com", "bedrock-agentcore", "harness"),
    });

    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [`arn:${cdk.Stack.of(this).partition}:bedrock:${cdk.Stack.of(this).region}::foundation-model/*`],
      }),
    );
    // The per-invocation model-override demo (issue #22's acceptance
    // criterion 2) can name a different foundation model at call time, so
    // this grant is wildcarded across every foundation model rather than
    // pinned to HARNESS_DEFAULT_MODEL_ID alone.
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [props.gatewayArn],
      }),
    );

    this.harness = new agentcore.CfnHarness(this, "Harness", {
      harnessName: HARNESS_NAME,
      executionRoleArn: this.executionRole.roleArn,
      model: { bedrockModelConfig: { modelId: HARNESS_DEFAULT_MODEL_ID } },
      systemPrompt: [{ text: HARNESS_SYSTEM_PROMPT }],
      tools: [
        {
          type: "agentcore_gateway",
          name: "booking",
          config: { agentCoreGateway: { gatewayArn: props.gatewayArn, outboundAuth: { awsIam: {} } } },
        },
      ],
      maxIterations: 8,
      timeoutSeconds: 60,
    });
  }
}

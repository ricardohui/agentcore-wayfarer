import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { HarnessComparisonConstruct } from "./harness-comparison-construct";

export type HarnessComparisonStackProps = cdk.StackProps & {
  readonly gatewayArn: string;
};

// Entirely separate from ConciergeStack (issue #22 / ADR-0002): its own
// stack, its own bin entry, deployed by hand against the booking Gateway's
// already-deployed ARN — never part of `npm run deploy`.
export class HarnessComparisonStack extends cdk.Stack {
  public readonly harnessComparison: HarnessComparisonConstruct;

  constructor(scope: Construct, id: string, props: HarnessComparisonStackProps) {
    super(scope, id, props);

    this.harnessComparison = new HarnessComparisonConstruct(this, "HarnessComparison", {
      gatewayArn: props.gatewayArn,
    });

    new cdk.CfnOutput(this, "HarnessArn", { value: this.harnessComparison.harness.attrArn });
  }
}

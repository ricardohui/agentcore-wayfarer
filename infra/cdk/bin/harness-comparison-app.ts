#!/usr/bin/env node
// Harness's standalone comparison build (issue #22 / ADR-0002) — its own CDK
// app, deployed independently of `npm run deploy`'s ConciergeStack. Needs the
// already-deployed booking Gateway's ARN, read from ConciergeStack's own
// "GatewayArn" CloudFormation output:
//
//   aws cloudformation describe-stacks --stack-name WayfarerConciergeStack \
//     --query "Stacks[0].Outputs[?OutputKey=='GatewayArn'].OutputValue" --output text
//
// Usage:
//   npx cdk deploy --app "npx ts-node --prefer-ts-exts infra/cdk/bin/harness-comparison-app.ts" \
//     --context gatewayArn=<the ARN above>
import * as cdk from "aws-cdk-lib";
import { HarnessComparisonStack } from "../lib/harness-comparison-stack";

const app = new cdk.App();

const gatewayArn = app.node.tryGetContext("gatewayArn") as string | undefined;
if (!gatewayArn) {
  throw new Error(
    "Missing required context value 'gatewayArn' — pass --context gatewayArn=<booking Gateway's ARN>, " +
      "read from ConciergeStack's own \"GatewayArn\" output.",
  );
}

const account = process.env.CDK_DEFAULT_ACCOUNT;

new HarnessComparisonStack(app, "WayfarerHarnessComparisonStack", {
  env: {
    ...(account ? { account } : {}),
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Wayfarer Harness - standalone comparison build of the search+hold beat (issue #22)",
  gatewayArn,
});

app.synth();

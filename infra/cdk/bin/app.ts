#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ConciergeStack } from "../lib/concierge-stack";

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;

new ConciergeStack(app, "WayfarerConciergeStack", {
  env: {
    ...(account ? { account } : {}),
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Wayfarer Concierge - Runtime walking skeleton (issue #14)",
});

app.synth();

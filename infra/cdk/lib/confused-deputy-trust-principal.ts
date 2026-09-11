import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

// Confused-deputy-protected service-principal trust condition, shared by
// every construct whose service role is assumed by an AWS service acting on
// this account's own resources of one type (Knowledge Base, Gateway, Harness)
// — matches AWS's own documented service-role trust relationship pattern.
export function confusedDeputyTrustPrincipal(
  scope: Construct,
  servicePrincipal: string,
  arnService: string,
  resourceType: string,
): iam.ServicePrincipal {
  return new iam.ServicePrincipal(servicePrincipal, {
    conditions: {
      StringEquals: { "aws:SourceAccount": cdk.Stack.of(scope).account },
      ArnLike: {
        "aws:SourceArn": cdk.Stack.of(scope).formatArn({
          service: arnService,
          resource: resourceType,
          resourceName: "*",
        }),
      },
    },
  });
}

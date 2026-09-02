import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { CONCIERGE_MODEL_ID } from "../../../src/concierge/infra/model-id";
import { BookingGatewayConstruct } from "./booking-gateway-construct";
import { IdentityConstruct } from "./identity-construct";

const HANDLER_BUNDLE_DIR = path.join(__dirname, "../../../dist/concierge");

export class ConciergeStack extends cdk.Stack {
  public readonly runtime: agentcore.Runtime;
  public readonly bookingGateway: BookingGatewayConstruct;
  public readonly memory: agentcore.Memory;
  public readonly identity: IdentityConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bookingGateway = new BookingGatewayConstruct(this, "BookingGateway");
    this.identity = new IdentityConstruct(this, "Identity");

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
      // Inbound auth (issue #17): the platform's own JWT authorizer rejects
      // a missing/invalid Cognito-issued token before this Runtime's code
      // ever runs — CognitoJwtVerifier in the handler is defense-in-depth on
      // top of this, and the only layer local tests can exercise.
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
        this.identity.userPool,
        [this.identity.userPoolClient],
      ),
      environmentVariables: {
        CONCIERGE_MODEL_ID,
        AWS_REGION: this.region,
        GATEWAY_URL: this.bookingGateway.gateway.attrGatewayUrl,
        MEMORY_ID: this.memory.memoryId,
        COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${this.identity.userPool.userPoolId}`,
        COGNITO_CLIENT_ID: this.identity.userPoolClient.userPoolClientId,
        CALENDAR_CREDENTIAL_PROVIDER_NAME: this.identity.credentialProviderName,
        CALENDAR_API_URL: this.identity.calendarFunctionUrl.url,
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

    // Delegated credential (issue #17): lets the Runtime's own workload
    // identity fetch/refresh a calendar OAuth2 token from Identity's token
    // vault on the Caller's behalf.
    this.identity.credentialProvider.grantUse(this.runtime.role);

    new cdk.CfnOutput(this, "RuntimeArn", { value: this.runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, "RuntimeId", { value: this.runtime.agentRuntimeId });
    new cdk.CfnOutput(this, "GatewayUrl", { value: this.bookingGateway.gateway.attrGatewayUrl });
    new cdk.CfnOutput(this, "MemoryId", { value: this.memory.memoryId });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.identity.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.identity.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "CalendarApiUrl", { value: this.identity.calendarFunctionUrl.url });
    new cdk.CfnOutput(this, "TestUserPasswordSecretArn", {
      value: this.identity.testUserPasswordSecret.secretArn,
      description: "Retrieve the generated Cognito test user's password from this secret",
    });
  }
}

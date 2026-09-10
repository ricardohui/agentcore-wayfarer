import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { CONCIERGE_MODEL_ID } from "../../../src/concierge/infra/model-id";
import { CONCIERGE_RUNTIME_NAME } from "../../../src/concierge/observability/runtime-name";
import { BookingGatewayConstruct } from "./booking-gateway-construct";
import { EvaluationsConstruct } from "./evaluations-construct";
import { GuardrailConstruct } from "./guardrail-construct";
import { IdentityConstruct } from "./identity-construct";
import { KnowledgeBaseConstruct } from "./knowledge-base-construct";
import { PriceCheckSiteConstruct } from "./price-check-site-construct";

const HANDLER_BUNDLE_DIR = path.join(__dirname, "../../../dist/concierge");

export class ConciergeStack extends cdk.Stack {
  public readonly runtime: agentcore.Runtime;
  public readonly bookingGateway: BookingGatewayConstruct;
  public readonly knowledgeBase: KnowledgeBaseConstruct;
  public readonly memory: agentcore.Memory;
  public readonly identity: IdentityConstruct;
  public readonly codeInterpreter: agentcore.CodeInterpreterCustom;
  public readonly priceCheckSite: PriceCheckSiteConstruct;
  public readonly priceCheckBrowser: agentcore.BrowserCustom;
  public readonly evaluations: EvaluationsConstruct;
  public readonly onlineEvaluationConfig: agentcore.OnlineEvaluationConfig;
  public readonly guardrail: GuardrailConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bookingGateway = new BookingGatewayConstruct(this, "BookingGateway");
    this.identity = new IdentityConstruct(this, "Identity");
    this.priceCheckSite = new PriceCheckSiteConstruct(this, "PriceCheckSite");

    // Knowledge Base's destination-guide retrieval (issue #21 / ADR-0010): a
    // Bedrock Managed Knowledge Base, queried by a direct in-process
    // bedrock-agent-runtime Retrieve call from the Runtime itself — no
    // Gateway target.
    this.knowledgeBase = new KnowledgeBaseConstruct(this, "KnowledgeBase");

    // The Guardrail (issue #26 / ADR-0011): blanket content-safety
    // protection on every Converse call, plus contextual grounding for
    // Knowledge Base retrieval content.
    this.guardrail = new GuardrailConstruct(this, "Guardrail");

    // Evaluations (issue #23 / ADR-0007): two AND'd custom evaluators judging
    // itinerary quality, triggered on-demand against live-generated session
    // transcripts (not wired into the Runtime's own environment - unlike
    // every other primitive above, Evaluations reads a session's CloudWatch
    // trace after the fact rather than being called during the session).
    this.evaluations = new EvaluationsConstruct(this, "Evaluations");

    // Browser Tool's price-check (issue #19 / ADR-0005): PUBLIC network mode
    // (the default) — the mock price-check site is a public S3 static
    // website, no VPC/private connectivity needed to reach it.
    this.priceCheckBrowser = new agentcore.BrowserCustom(this, "PriceCheckBrowser", {
      browserCustomName: "wayfarer_price_check_browser",
      description: "Wayfarer price-check Browser Tool (issue #19 / ADR-0005)",
      networkConfiguration: agentcore.BrowserNetworkConfiguration.usingPublicNetwork(),
    });

    // Code Interpreter's budget/currency math (issue #18 / ADR-0004): Sandbox
    // network mode (no internet egress) — the static mock rate table is
    // embedded in the executed code, so the sandbox never needs to reach a
    // real forex API.
    this.codeInterpreter = new agentcore.CodeInterpreterCustom(this, "BudgetCodeInterpreter", {
      codeInterpreterCustomName: "wayfarer_budget_interpreter",
      description: "Wayfarer budget/currency math sandbox (issue #18 / ADR-0004)",
      networkConfiguration: agentcore.CodeInterpreterNetworkConfiguration.usingSandboxNetwork(),
    });

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
      runtimeName: CONCIERGE_RUNTIME_NAME,
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
      // AgentCore strips the Authorization header before invoking the
      // container by default — CognitoJwtVerifier's defense-in-depth check
      // (handler.ts) never sees a token without this (issue #17).
      requestHeaderConfiguration: { allowlistedHeaders: ["Authorization"] },
      environmentVariables: {
        CONCIERGE_MODEL_ID,
        AWS_REGION: this.region,
        GATEWAY_URL: this.bookingGateway.gateway.attrGatewayUrl,
        MEMORY_ID: this.memory.memoryId,
        COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${this.identity.userPool.userPoolId}`,
        COGNITO_CLIENT_ID: this.identity.userPoolClient.userPoolClientId,
        CALENDAR_CREDENTIAL_PROVIDER_NAME: this.identity.credentialProviderName,
        CALENDAR_API_URL: this.identity.calendarFunctionUrl.url,
        CODE_INTERPRETER_ID: this.codeInterpreter.codeInterpreterId,
        BROWSER_ID: this.priceCheckBrowser.browserId,
        PRICE_CHECK_SITE_URL: this.priceCheckSite.siteUrl,
        KNOWLEDGE_BASE_ID: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseId,
        GUARDRAIL_ID: this.guardrail.guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: this.guardrail.version.attrVersion,
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
    // The Guardrail (issue #26 / ADR-0011): a Converse call carrying
    // guardrailConfig needs bedrock:ApplyGuardrail on the guardrail's own
    // resource ARN, separate from bedrock:InvokeModel on the foundation
    // model — confirmed live: the first post-deploy Converse call failed
    // with an AccessDeniedException naming this exact action before this
    // grant was added.
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:ApplyGuardrail"],
        resources: [this.guardrail.guardrail.attrGuardrailArn],
      }),
    );
    // The Guardrail's IAM enforcement (issue #26 / ADR-0011): an explicit
    // Deny on this role alone (not account- or org-wide) that fails closed
    // if InvokeModel/InvokeModelWithResponseStream is ever called without
    // this exact pinned guardrail+version attached — so no future code
    // change can silently invoke the model unguarded. The condition value's
    // ARN:version format matches AWS's own documented pattern for this key.
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"],
        conditions: {
          StringNotEquals: {
            "bedrock:GuardrailIdentifier": `${this.guardrail.guardrail.attrGuardrailArn}:${this.guardrail.version.attrVersion}`,
          },
        },
      }),
    );
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [this.bookingGateway.gateway.attrGatewayArn],
      }),
    );
    // Knowledge Base's destination-guide retrieval (issue #21 / ADR-0010): a
    // direct in-process Retrieve call needs this on the Runtime's own role —
    // no Gateway execution role involved.
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:Retrieve"],
        resources: [
          this.formatArn({
            service: "bedrock",
            resource: "knowledge-base",
            resourceName: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseId,
          }),
        ],
      }),
    );
    this.memory.grantWrite(this.runtime.role);
    this.memory.grantReadShortTermMemory(this.runtime.role);
    this.memory.grantReadLongTermMemory(this.runtime.role);

    // Delegated credential (issue #17): lets the Runtime's own workload
    // identity fetch/refresh a calendar OAuth2 token from Identity's token
    // vault on the Caller's behalf.
    this.identity.credentialProvider.grantUse(this.runtime.role);

    // Code Interpreter's budget/currency math (issue #18): Start/Invoke/Stop
    // on the sandbox the Runtime's own role uses to run each hold's
    // conversion.
    this.codeInterpreter.grantUse(this.runtime.role);

    // Browser Tool's price-check (issue #19): Start/Update/Stop on the
    // browser the Runtime's own role uses for each hold's one-shot session.
    this.priceCheckBrowser.grantUse(this.runtime.role);
    // grantUse() alone isn't enough — confirmed against the real deployed
    // Runtime that PlaywrightBrowser's connectOverCDP (the actual page
    // navigation, not session start/stop) needs this separate stream
    // permission, or it 403s despite a successfully started session.
    this.priceCheckBrowser.grant(this.runtime.role, "bedrock-agentcore:ConnectBrowserAutomationStream");

    // Observability (issue #24 / ADR-0008): the Runtime's own role signs and
    // sends span export requests directly to X-Ray's OTLP endpoint
    // (src/concierge/observability/tracing.ts) - hand-rolled, since AgentCore
    // doesn't auto-emit spans and the AWS Node ADOT distro's auto-
    // instrumentation can't be used against this ESM bundle (ADR-0007's
    // Revision). X-Ray write actions aren't ARN-scoped (matches the
    // AWSXRayDaemonWriteAccess managed policy's own "Resource": ["*"]).
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["xray:PutTraceSegments", "xray:PutSpans", "xray:PutSpansForIndexing", "xray:PutTelemetryRecords"],
        resources: ["*"],
      }),
    );
    // Split telemetry's event-record pipeline (issue #23 / ADR-0007's
    // Revision 3, src/concierge/observability/tracing.ts): the Runtime
    // discovers its own log group (DescribeLogGroups isn't resource-scoped
    // to a specific log group ARN - it lists across the account), then
    // ensures the otel-rt-logs stream exists and writes to it. Same
    // wildcard reasoning as the PutResourcePolicy grant above - the
    // Runtime's own generated log group name isn't known at synth time.
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["logs:DescribeLogGroups"],
        resources: ["*"],
      }),
    );
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: "/aws/bedrock-agentcore/runtimes/*:log-stream:otel-rt-logs",
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Online evaluation (issue #23 / ADR-0007's Revision 4): continuous
    // sampling of live Runtime sessions against the same two AND'd
    // evaluators the on-demand script drives by hand. 100% sampling, not the
    // L2's 10% default - low real traffic here (a single test Caller), and
    // ADR-0008 already established 100% sampling as this project's Traces
    // policy for the same reason. Data source derives the Runtime's own log
    // group/service name automatically (the recommended AgentCore-native
    // path) rather than hand-naming them the way DataSourceConfig.
    // fromCloudWatchLogs() would require.
    this.onlineEvaluationConfig = new agentcore.OnlineEvaluationConfig(this, "OnlineEvaluation", {
      onlineEvaluationConfigName: "wayfarer_concierge_online_eval",
      description: "Wayfarer itinerary-quality continuous sampling (issue #23 / ADR-0007)",
      evaluators: [
        agentcore.EvaluatorSelector.custom(this.evaluations.budgetGateEvaluator),
        agentcore.EvaluatorSelector.custom(this.evaluations.itineraryQualityEvaluator),
      ],
      dataSource: agentcore.DataSourceConfig.fromAgentRuntimeEndpoint(this.runtime),
      samplingPercentage: 100,
      // The L2's own doc claims ExecutionStatus.ENABLED as the default when
      // omitted - confirmed false against the real deploy: leaving this out
      // emits no ExecutionStatus property at all, and the CFN resource's own
      // default is DISABLED. Set explicitly, or nothing gets sampled.
      executionStatus: agentcore.ExecutionStatus.ENABLED,
    });
    // The auto-created execution role only knows how to call the AgentCore
    // control plane - it has no idea our budget-gate evaluator is backed by
    // a Lambda it needs to invoke directly. Confirmed against the real
    // deploy: CreateOnlineEvaluationConfig 400s without this ("execution
    // role ... does not have permission to access the specified Lambda
    // functions"), lambda:GetFunction named explicitly alongside Invoke in
    // AWS's own error message.
    if (this.onlineEvaluationConfig.executionRole) {
      this.evaluations.budgetGateLambda.grantInvoke(this.onlineEvaluationConfig.executionRole);
      this.onlineEvaluationConfig.executionRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["lambda:GetFunction"],
          resources: [this.evaluations.budgetGateLambda.functionArn],
        }),
      );
    }

    new cdk.CfnOutput(this, "RuntimeArn", { value: this.runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, "RuntimeId", { value: this.runtime.agentRuntimeId });
    new cdk.CfnOutput(this, "GatewayUrl", { value: this.bookingGateway.gateway.attrGatewayUrl });
    // Read by the Harness comparison build's own stack (issue #22 / ADR-0002)
    // to wire its agentcore_gateway tool to this same Gateway target — that
    // stack never references this one's CDK constructs directly.
    new cdk.CfnOutput(this, "GatewayArn", { value: this.bookingGateway.gateway.attrGatewayArn });
    new cdk.CfnOutput(this, "PolicyEngineId", { value: this.bookingGateway.policyEngine.attrPolicyEngineId });
    new cdk.CfnOutput(this, "MemoryId", { value: this.memory.memoryId });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.identity.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.identity.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "CalendarApiUrl", { value: this.identity.calendarFunctionUrl.url });
    new cdk.CfnOutput(this, "TestUserPasswordSecretArn", {
      value: this.identity.testUserPasswordSecret.secretArn,
      description: "Retrieve the generated Cognito test user's password from this secret",
    });
    new cdk.CfnOutput(this, "CodeInterpreterId", { value: this.codeInterpreter.codeInterpreterId });
    new cdk.CfnOutput(this, "PriceCheckSiteUrl", { value: this.priceCheckSite.siteUrl });
    new cdk.CfnOutput(this, "PriceCheckBrowserId", { value: this.priceCheckBrowser.browserId });
    new cdk.CfnOutput(this, "KnowledgeBaseId", { value: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, "KnowledgeBaseDataSourceId", { value: this.knowledgeBase.dataSource.attrDataSourceId });
    new cdk.CfnOutput(this, "BudgetGateEvaluatorId", { value: this.evaluations.budgetGateEvaluator.evaluatorId });
    new cdk.CfnOutput(this, "ItineraryQualityEvaluatorId", {
      value: this.evaluations.itineraryQualityEvaluator.evaluatorId,
    });
    new cdk.CfnOutput(this, "OnlineEvaluationConfigId", {
      value: this.onlineEvaluationConfig.onlineEvaluationConfigId,
    });
    new cdk.CfnOutput(this, "GuardrailId", { value: this.guardrail.guardrail.attrGuardrailId });
    new cdk.CfnOutput(this, "GuardrailVersion", { value: this.guardrail.version.attrVersion });
  }
}

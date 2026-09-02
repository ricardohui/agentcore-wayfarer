import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

const CALENDAR_LAMBDA_BUNDLE_DIR = path.join(__dirname, "../../../dist/calendar-oauth-server");

// A single mock test user (ADR-0003).
const TEST_USER_EMAIL = "wayfarer-test-user@example.com";

export const CALENDAR_OAUTH_CLIENT_ID = "wayfarer-calendar-client";
const CALENDAR_CREDENTIAL_PROVIDER_NAME = "wayfarer_calendar_oauth2";

// Identity (issue #17 / ADR-0003): a Cognito user pool for Runtime's inbound
// JWT authorizer (revising Memory's actorId placeholder to the Caller's real
// `sub`), plus a Lambda-backed mock OAuth2 authorization server — a real
// authorization-code+PKCE flow, real signed tokens — fronting a mock
// calendar-events store, registered with AgentCore Identity as a custom
// OAuth2 vendor for the consent handshake's Delegated credential.
export class IdentityConstruct extends cdk.Resource {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly calendarLambda: lambda.Function;
  public readonly calendarFunctionUrl: lambda.FunctionUrl;
  public readonly credentialProvider: agentcore.OAuth2CredentialProvider;
  public readonly credentialProviderName = CALENDAR_CREDENTIAL_PROVIDER_NAME;
  // Generated, not hardcoded — retrieve it from Secrets Manager to sign in
  // as the test user.
  public readonly testUserPasswordSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, "CallerUserPool", {
      userPoolName: "wayfarer-caller-pool",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
    });
    this.userPoolClient = this.userPool.addClient("ConciergeClient", {
      authFlows: { userPassword: true },
      generateSecret: false,
    });

    this.testUserPasswordSecret = this.provisionTestUser();

    const clientSecret = new secretsmanager.Secret(this, "CalendarOAuthClientSecret", {
      description: "Wayfarer calendar mock OAuth2 authorization server - client secret (issue #17)",
    });
    const signingSecret = new secretsmanager.Secret(this, "CalendarOAuthSigningSecret", {
      description: "Wayfarer calendar mock OAuth2 authorization server - access token signing key (issue #17)",
    });

    const table = new dynamodb.Table(this, "CalendarOAuthTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
    });

    this.calendarLambda = new lambda.Function(this, "CalendarOAuthLambda", {
      functionName: "wayfarer-calendar-oauth-server",
      description: "Wayfarer mock calendar OAuth2 authorization server + events store (issue #17 / ADR-0003)",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "app.handler",
      code: lambda.Code.fromAsset(CALENDAR_LAMBDA_BUNDLE_DIR),
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        CLIENT_ID: CALENDAR_OAUTH_CLIENT_ID,
        CLIENT_SECRET_ARN: clientSecret.secretArn,
        SIGNING_SECRET_ARN: signingSecret.secretArn,
        // The issuer/audience a token is minted and verified against — this
        // Lambda never actually receives inbound traffic at this exact URL
        // pre-deploy, it's only ever compared against itself.
        ISSUER: "https://wayfarer-calendar-oauth.internal",
      },
    });
    table.grantReadWriteData(this.calendarLambda);
    clientSecret.grantRead(this.calendarLambda);
    signingSecret.grantRead(this.calendarLambda);

    this.calendarFunctionUrl = this.calendarLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    this.credentialProvider = agentcore.OAuth2CredentialProvider.usingCustom(this, "CalendarCredentialProvider", {
      oAuth2CredentialProviderName: CALENDAR_CREDENTIAL_PROVIDER_NAME,
      clientId: CALENDAR_OAUTH_CLIENT_ID,
      clientSecret: cdk.SecretValue.secretsManager(clientSecret.secretArn),
      authorizationServerMetadata: {
        issuer: "https://wayfarer-calendar-oauth.internal",
        authorizationEndpoint: `${this.calendarFunctionUrl.url}authorize`,
        tokenEndpoint: `${this.calendarFunctionUrl.url}token`,
      },
    });

    // The mock authorization server validates redirect_uri against
    // AgentCore's own callback URL, known only once the credential provider
    // exists — set after the fact rather than threading it through the
    // Lambda's initial environment block above. Fails synth outright rather
    // than deploying an authorization server that accepts any redirect_uri.
    if (!this.credentialProvider.callbackUrl) {
      throw new Error("OAuth2CredentialProvider did not produce a callbackUrl");
    }
    this.calendarLambda.addEnvironment("EXPECTED_REDIRECT_URI", this.credentialProvider.callbackUrl);
  }

  private provisionTestUser(): secretsmanager.Secret {
    const createUser = new cr.AwsCustomResource(this, "TestUser", {
      onCreate: {
        service: "CognitoIdentityServiceProvider",
        action: "adminCreateUser",
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: TEST_USER_EMAIL,
          UserAttributes: [
            { Name: "email", Value: TEST_USER_EMAIL },
            { Name: "email_verified", Value: "true" },
          ],
          MessageAction: "SUPPRESS",
        },
        physicalResourceId: cr.PhysicalResourceId.of("wayfarer-test-user"),
      },
      onDelete: {
        service: "CognitoIdentityServiceProvider",
        action: "adminDeleteUser",
        parameters: { UserPoolId: this.userPool.userPoolId, Username: TEST_USER_EMAIL },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.userPool.userPoolArn] }),
    });

    const testUserPasswordSecret = new secretsmanager.Secret(this, "TestUserPasswordSecret", {
      description: "Wayfarer Cognito test user password (issue #17 / ADR-0003) - generated, not hardcoded",
      generateSecretString: { passwordLength: 24, requireEachIncludedType: true },
    });

    // A freshly created Cognito user starts in FORCE_CHANGE_PASSWORD state —
    // a second call sets a permanent password so the test user can actually
    // sign in without an interactive challenge.
    const setPassword = new cr.AwsCustomResource(this, "TestUserPassword", {
      onCreate: {
        service: "CognitoIdentityServiceProvider",
        action: "adminSetUserPassword",
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: TEST_USER_EMAIL,
          Password: testUserPasswordSecret.secretValue.unsafeUnwrap(),
          Permanent: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of("wayfarer-test-user-password"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.userPool.userPoolArn] }),
    });
    setPassword.node.addDependency(createUser);
    return testUserPasswordSecret;
  }
}

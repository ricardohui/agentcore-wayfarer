# Concierge UI

Dev tool — minimal chat UI against the deployed `wayfarer_concierge` AgentCore
Runtime. Not part of the Wayfarer map/PRD.

## Setup (one-time)

```
npm install
```

`.env` needs `RUNTIME_ARN`, `AWS_REGION`, and `COGNITO_CLIENT_ID`. See
`.env.example`. Fetch them with:

```
aws cloudformation describe-stacks --stack-name WayfarerConciergeStack \
  --region us-east-1 --query "Stacks[0].Outputs"
```

`RuntimeArn` → `RUNTIME_ARN`, `UserPoolClientId` → `COGNITO_CLIENT_ID`.

## Signing in (issue #17)

The Runtime's inbound authorizer is Cognito — every invoke needs a bearer
JWT, not just AWS credentials. The stack provisions one test user
(`wayfarer-test-user@example.com`) with a generated password. Fetch it from
the `TestUserPasswordSecretArn` output above:

```
aws secretsmanager get-secret-value --region us-east-1 \
  --secret-id <TestUserPasswordSecretArn> --query SecretString --output text
```

Use that email/password in the UI's sign-in form — the proxy exchanges them
for a Cognito access token (`/api/login`, `USER_PASSWORD_AUTH`) and attaches
it as `Authorization: Bearer <token>` on every `/api/invoke` call. The token
is kept in `sessionStorage`, not persisted across browser restarts.

## Run

Two terminals, both from this directory:

```
npm run proxy   # localhost:8787 — forwards to AWS
npm run dev     # localhost:5173ish — opens the UI
```

The proxy needs AWS credentials on its default chain (`aws sso login` or
equivalent) — those are only used to call Cognito's `InitiateAuth`; the
actual agent invoke is a bearer-token HTTPS call per AWS's inbound-auth
Runtime docs (the AWS SDK can't SigV4-sign `InvokeAgentRuntime` once a
Runtime uses a JWT authorizer).

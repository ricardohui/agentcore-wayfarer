# Concierge UI

Dev tool — minimal chat UI against the deployed `wayfarer_concierge` AgentCore
Runtime. Not part of the Wayfarer map/PRD.

## Setup (one-time)

```
npm install
```

`.env` needs `RUNTIME_ARN` (deployed Runtime's ARN) and `AWS_REGION`. See
`.env.example`. Fetch the ARN with:

```
aws cloudformation describe-stacks --stack-name WayfarerConciergeStack \
  --region us-east-1 --query "Stacks[0].Outputs"
```

## Run

Two terminals, both from this directory:

```
npm run proxy   # localhost:8787 — signs and forwards to AWS
npm run dev     # localhost:5173ish — opens the UI
```

Proxy uses your default AWS credential chain — must be signed in
(`aws sso login` or equivalent) before `npm run proxy`.

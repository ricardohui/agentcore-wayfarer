# Wayfarer PRD

Requirements are written as testable statements with stable IDs. Each requirement is
implemented by one primitive's slice (see `docs/adr/` for the design decisions behind
each slice, and GitHub issue #13 for the parent build spec).

## REQ-RUNTIME-001 — Concierge deployed to AgentCore Runtime, invocable end to end

The Concierge handler is deployed to AgentCore Runtime (Node.js direct code deployment,
`BedrockAgentCoreApp`) and answers a Caller message with a model-generated reply through
the real entry point (`/invocations`), with a passing `/ping` health check.

Source: issue #14, acceptance criterion 1.

## REQ-RUNTIME-002 — Runtime sessions are isolated

Two Runtime sessions, identified by distinct `runtimeSessionId`s, never observe each
other's conversation state. A message recorded under session A is invisible to session B.

Source: issue #14, acceptance criterion 2.

## REQ-RUNTIME-003 — Composition root wires real adapters

The Concierge's entry point is assembled at a single composition root from real adapters
(model client, conversation repository) implementing usecase-owned ports. No service
locators; no `new` for a collaborator inside usecase or domain code.

Source: issue #14, acceptance criterion 3.

## REQ-GATEWAY-001 — Search returns candidates with Local-currency prices across the 3 scenario cities

`search-flights` and `search-hotels` return candidates for one of Wayfarer's 3 scenario
cities (TOKYO, PARIS, NEW_YORK), each priced as `{ amount, currency }` in that
destination's Local currency.

Source: issue #15, acceptance criterion 1.

## REQ-GATEWAY-002 — Hold returns a holdId, status, and expiresAt

`hold-flight` and `hold-hotel` place a tentative hold on a chosen candidate and return
`{ holdId, status, expiresAt }`. Not a finalized booking.

Source: issue #15, acceptance criterion 2.

## REQ-GATEWAY-003 — Search-then-hold vertical slice through the real Runtime entry point

A Caller asking to plan a trip drives the Concierge, through the real Runtime entry
point, to search flights/hotels via Gateway's booking target and place at least one
flight hold and one hotel hold, with only the network boundary (the Concierge's calls
out to Gateway) mocked.

Source: issue #15, acceptance criterion 3.

## REQ-GATEWAY-004 — Gateway's booking target is fully CDK-provisioned

The mock router Lambda, its tool schema (search-flights, search-hotels, hold-flight,
hold-hotel), and the Gateway + Gateway target are provisioned entirely by CDK — no
console or bare-CLI provisioning. Verified by `cdk synth` succeeding, not an automated
test (there is no deployed AWS state to assert against pre-deploy).

Source: issue #15, acceptance criterion 5.

## REQ-MEMORY-001 — Scratch state is session-scoped, not cross-session

The Concierge's per-turn transcript is held via Memory's create_event/get_last_k_turns
(session-scoped, actorId-scoped), not an ad hoc in-process cache: a fresh
`runtimeSessionId` sees no prior turns, even for an actorId with turns recorded under a
different session. Cross-session in-progress-trip resumption is explicitly not
implemented.

Source: issue #16, acceptance criteria 1 and 4.

## REQ-MEMORY-002 — A returning actor is recognized by previously extracted preferences

Two long-term Memory Strategies (`user-preference` for stable facts, `semantic` for
soft free-form ones) are configured on the Memory resource. Before generating a reply,
the Concierge recalls whatever those Strategies have already extracted for the
requesting actorId and folds it into the model's context, so a second session for the
same actorId can reflect a preference extracted from an earlier one.

Source: issue #16, acceptance criteria 2, 3, and 5.

## REQ-IDENTITY-001 — Unauthenticated or invalid-JWT requests are rejected before the usecase runs

A request with no Authorization header, or one carrying an invalid-signature, wrong-audience, or
expired JWT, never reaches `respondToCallerMessage` — the model client and every other usecase
port are left uncalled. AgentCore Runtime's own platform-level JWT authorizer enforces this in
production; the Concierge's own `CognitoJwtVerifier` check in `infra/handler.ts` is
defense-in-depth and the only layer this repo's tests can exercise directly.

Source: issue #17, acceptance criterion 1.

## REQ-IDENTITY-002 — actorId is the Caller's Cognito `sub`

A valid Cognito-issued JWT's `sub` claim becomes the session's actorId, replacing issue #16's
`PLACEHOLDER_ACTOR_ID` (now removed). Memory's Strategies (REQ-MEMORY-002) key off this same
actorId, so a returning Caller's long-term preferences are recalled by their real inbound identity.

Source: issue #17, acceptance criterion 2.

## REQ-IDENTITY-003 — A calendar write with no Delegated credential surfaces an authorization URL

The Concierge's first `write-calendar-event` tool call for a Caller who hasn't yet consented fails
with a ConsentRequired result carrying an authorizationUrl, which the model surfaces to the Caller
mid-conversation instead of a raw error.

Source: issue #17, acceptance criterion 3.

## REQ-IDENTITY-004 — A retried calendar write succeeds once consent is on file

Once Identity's token vault holds a Delegated credential (out-of-band Caller approval), a retried
`write-calendar-event` call for the same holdId succeeds and the mock calendar-events store holds
a record referencing that holdId and title.

Source: issue #17, acceptance criterion 4.

## REQ-IDENTITY-005 — The consent handshake happens at most once per Caller per external target

A second calendar write in the same or a later session, for a Caller who has already consented,
does not surface an authorization URL again — Identity's token vault answers with an access token
immediately.

Source: issue #17, acceptance criterion 5.

## REQ-IDENTITY-006 — The consent-then-retry flow is driven through the real Runtime entry point

An acceptance test drives the full first-attempt-fails / approve / retry-succeeds sequence through
the real `/invocations` entry point, with only the network boundary (Identity's GetResourceOauth2Token
call and the mock calendar-events HTTP API) mocked.

Source: issue #17, acceptance criterion 6.

## REQ-IDENTITY-007 — Identity's infrastructure is fully CDK-provisioned

The Cognito user pool + app client (Runtime's inbound JWT authorizer), the mock OAuth2
authorization server Lambda (`/authorize`, `/token`, `/events`) behind a Function URL, its
DynamoDB-backed store, its two Secrets Manager secrets (client secret, token signing key), and the
`OAuth2CredentialProvider` registering it as a custom vendor are all provisioned by CDK — no
console or bare-CLI provisioning. Verified by `cdk synth` succeeding, not an automated test, same
as REQ-GATEWAY-004.

Source: issue #17, acceptance criterion 7 (integration-test coverage of JWT expiry/invalid-signature
and OAuth2 token refresh/expiry is exercised directly against the authorization server Lambda's
router, `tests/calendar-oauth-server/infra/router.spec.ts`, and against `CognitoJwtVerifier`,
`tests/concierge/adapter/cognito-jwt-verifier.spec.ts`).

## REQ-CODEINTERPRETER-001 — A single Code Interpreter session persists across a planning conversation

One Sandbox-mode Code Interpreter session is started per RuntimeSessionId and reused for every
subsequent hold in that conversation (`clearContext: false`) — a second, later hold in the same
session does not start a new sandbox session.

Source: issue #18, acceptance criterion 1.

## REQ-CODEINTERPRETER-002 — Every successful hold triggers a real executeCode currency conversion

A successful `hold-flight`/`hold-hotel` call converts the held candidate's Live price (issue #19 —
see REQ-BROWSERTOOL-004; originally the candidate's Quoted price before issue #19) to Home currency
(USD) via a real `executeCode` call against the static mock rate table (ADR-0004) — never
model-guessed arithmetic. The candidate's city/category is whichever was last returned for that
candidateId by `search-flights`/`search-hotels` in the same tool-executor instance.

Source: issue #18, acceptance criterion 2 (revised by issue #19).

## REQ-CODEINTERPRETER-003 — The Running total accumulates correctly across multiple holds in different Local currencies

Holding a flight and a hotel priced in two different Local currencies in the same conversation
produces a Running total that is the sum of both items' Home-currency amounts, reflected in the
`budget.runningTotal` field attached to each hold's tool result.

Source: issue #18, acceptance criterion 3.

## REQ-CODEINTERPRETER-004 — The Budget breakdown slices the Running total by city and by category

Each hold's tool result also carries `budget.breakdownByCity` and `budget.breakdownByCategory`
(flights vs hotels), recomputed alongside the Running total on every hold.

Source: issue #18, acceptance criterion 4.

## REQ-CODEINTERPRETER-005 — The budget flow is driven through the real Runtime entry point

An acceptance test holds a flight and a hotel priced in different Local currencies through the real
`/invocations` entry point, network boundary mocked (Gateway and Code Interpreter's
Start/InvokeCodeInterpreter calls), and asserts the Running total and breakdown numbers surfaced to
the model after each hold are numerically correct.

Source: issue #18, acceptance criterion 5.

## REQ-CODEINTERPRETER-006 — A Budget port failure never blocks a successful hold

Per CONTEXT.md's Running total ("observational, not a constraint"), a `BudgetPort` failure
(sandbox unavailable, execution failed) still returns the hold as successful — just without a
`budget` field in that hold's tool result.

Source: issue #18, acceptance criterion 6 (unit-tested via `BookingToolExecutor`'s in-memory
`FakeBudgetPort`; sandbox timeout/error-translation edge cases are integration-tested directly
against `CodeInterpreterBudgetAdapter`, `tests/concierge/adapter/code-interpreter-budget-adapter.spec.ts`).

## REQ-CODEINTERPRETER-007 — Code Interpreter's infrastructure is fully CDK-provisioned

A custom Code Interpreter resource in Sandbox network mode is provisioned by CDK
(`CodeInterpreterCustom` / `AWS::BedrockAgentCore::CodeInterpreterCustom`), with the Runtime's role
granted Start/Invoke/Stop on it. Verified by `cdk synth` succeeding, not an automated test, same as
REQ-GATEWAY-004 / REQ-IDENTITY-007.

## REQ-BROWSERTOOL-001 — A price-check runs automatically before every hold, never agent-discretion

Every `hold-flight`/`hold-hotel` call for a candidate this tool-executor instance has searched runs
a Browser Tool price-check (ADR-0005) before Gateway's hold call — unconditionally, with no path for
the model to skip it.

Source: issue #19, acceptance criterion 1.

## REQ-BROWSERTOOL-002 — The Live price is read from the mock price-check site and can diverge from Quoted

`PriceCheckPort.checkPrice` navigates a one-shot Browser Tool session to the mock price-check site
(a static page, CDK-deployed to S3, ADR-0005) and reads back a Live price computed independently of
Gateway's mock catalog — so it can differ from the candidate's Quoted price from search.

Source: issue #19, acceptance criterion 2.

## REQ-BROWSERTOOL-003 — The Caller is shown the Live price before the hold proceeds

A successful hold's tool result carries a `livePrice` field alongside `holdId`/`status`/`expiresAt`,
so the model can surface it to the Caller. The price-check runs before Gateway's hold call, and both
complete within the same tool-use round — never a separate agent-discretion confirmation step.

Source: issue #19, acceptance criterion 3.

## REQ-BROWSERTOOL-004 — The Running total is computed from Live price, not Quoted price

`BookingToolExecutor` passes the price-check's Live price (not the searched candidate's Quoted
price) to `BudgetPort.recordHold` — revising REQ-CODEINTERPRETER-002/003's conversion input.

Source: issue #19, acceptance criterion 4.

## REQ-BROWSERTOOL-005 — A candidate's divergent Live price drives a matching Running total

An acceptance test holds a candidate whose Live price (scripted to differ from its Quoted price)
ends up as the Running total Code Interpreter reports — not a total computed from Quoted price.

Source: issue #19, acceptance criterion 5 (`tests/concierge/acceptance/live-price-check.spec.ts`).

## REQ-BROWSERTOOL-006 — A price-check failure blocks the hold

Unlike a `BudgetPort` failure (REQ-CODEINTERPRETER-006, non-blocking), a `PriceCheckPort` failure
(Browser Tool navigation failure, or an unparseable price) surfaces as a tool error and Gateway's
hold call is never made — there is no price to hold at.

Source: issue #19, acceptance criterion 6 (unit-tested via `BookingToolExecutor`'s in-memory
`FakePriceCheckPort`; Browser Tool navigation-failure translation is integration-tested directly
against `BrowserToolPriceCheckAdapter`, `tests/concierge/adapter/browser-tool-price-check-adapter.spec.ts`).

## REQ-BROWSERTOOL-007 — The price-check site and Browser Tool resource are fully CDK-provisioned

The mock price-check site (a public S3 bucket, its single page deployed via `BucketDeployment` and
served from S3's REST endpoint — not S3 static *website* hosting, which AgentCore's managed Browser
Tool blocks outright, see the Changelog) and a `BrowserCustom` (`AWS::BedrockAgentCore::BrowserCustom`,
PUBLIC network mode) are both provisioned by CDK, with the Runtime's role granted Start/Update/Stop
on the browser (`grantUse`) plus the separate `ConnectBrowserAutomationStream` permission the actual
CDP navigation needs (not covered by `grantUse`, see the Changelog). Verified by `cdk synth`
succeeding, not an automated test, same as REQ-GATEWAY-004 / REQ-IDENTITY-007 / REQ-CODEINTERPRETER-007.

## REQ-POLICY-001 — A hold above the flat Local-currency threshold is DENYed before it takes effect

A `hold-flight`/`hold-hotel` call whose candidate's Live price exceeds Policy's flat
Local-currency threshold (500, ADR-0006) is DENYed at the Gateway boundary before Gateway's
router Lambda ever runs — the Concierge sees a `HoldGated` `GatewayError`, not a completed hold.

Source: issue #20, acceptance criterion 1.

## REQ-POLICY-002 — A Gated hold surfaces its price and requests the Caller's approval

A `HoldGated` denial's tool result carries the candidate's Live price and asks the model to
surface it to the Caller and request approval, rather than reporting a broken tool call.

Source: issue #20, acceptance criterion 2.

## REQ-POLICY-003 — Calling approve-hold allows the retried hold

Calling `approve-hold` emits an approval event Policy's temporal rule records; a hold-flight/
hold-hotel retried for the same Caller session immediately afterward is ALLOWed.

Source: issue #20, acceptance criterion 3.

## REQ-POLICY-004 — A hold at or under the threshold passes with no approval step

A `hold-flight`/`hold-hotel` call whose Live price is at or under the threshold is ALLOWed with
no prior `approve-hold` call required.

Source: issue #20, acceptance criterion 4.

## REQ-POLICY-005 — An approve-hold event is consumed by at most one hold

Once a Gated hold succeeds, the `approve-hold` event that authorized it is consumed: a second,
unrelated Gated hold attempt in the same Caller session cannot reuse it and is DENYed again
until a new `approve-hold` call is made.

Source: issue #20, acceptance criterion 5.

## REQ-POLICY-006 — The Gated-hold DENY, approve, ALLOW round trip is driven through the real Runtime entry point

An acceptance test drives a Gated hold's DENY, the Caller's approval, `approve-hold`, and the
retried hold's ALLOW through the real `/invocations` entry point, network boundary mocked
(Gateway's MCP calls), asserting the surfaced price and the final successful hold.

Source: issue #20, acceptance criterion 6 (`tests/concierge/acceptance/gated-hold-approval.spec.ts`).

## REQ-POLICY-007 — Policy's infrastructure is fully CDK-provisioned

A `CfnPolicyEngine` attached to the booking Gateway in `ENFORCE` mode, the NL-generated flat
threshold Cedar policy, the hand-written unconditional `approve-hold` Cedar policy, and the
hand-written one-time-consumption Dogwood temporal policy are all provisioned by CDK — no
console or bare-CLI provisioning. Verified by `cdk synth` succeeding, not an automated test,
same as REQ-GATEWAY-004 (integration coverage of the Policy-denial-to-`HoldGated` translation
and the Policy session header lives in
`tests/concierge/adapter/booking-gateway-adapter.spec.ts`, exercising Cedar policy
syntax/evaluation edge cases at the adapter seam rather than against real deployed AWS Policy
resources).

Source: issue #20, acceptance criterion 7.

## REQ-KB-001 — A destination question is answered from retrieved Knowledge Base content

A Caller's destination-related question (e.g. "what's the visa situation for city X?") is
answered using content retrieved from the Knowledge Base's `retrieve-destination-guide` tool,
not the model's own unaided knowledge — the retrieve call is agent-discretion (called when the
question looks destination-related), not forced at a fixed pipeline point.

Source: issue #21, acceptance criteria 1 and 3.

## REQ-KB-002 — All 3 scenario cities have queryable destination-guide content

Each of Wayfarer's 3 scenario cities (TOKYO, PARIS, NEW_YORK) has one authored destination-guide
document (visa/entry requirements, climate, customs, packing advice), ingested into the Knowledge
Base via its S3 connector and queryable via `retrieve`.

Source: issue #21, acceptance criterion 2.

## REQ-KB-003 — Destination-guide retrieval is read-only and ungated

Destination-guide retrieval is a direct in-process `bedrock-agent-runtime` call — no Gateway
target, no Policy rule gating or otherwise constraining it. This is a stronger form of the
original "same unconditional-permit treatment as `search-flights`/`search-hotels`" requirement:
rather than an explicit unconditional Cedar policy undoing the Policy engine's default-deny, the
call never passes through the Policy engine at all.

Source: issue #21, acceptance criterion 4; revised by ADR-0010.

## REQ-KB-004 — The destination-guide retrieval flow is driven through the real Runtime entry point

An acceptance test asks a destination question through the real `/invocations` entry point,
network boundary mocked at the direct `bedrock-agent-runtime` Retrieve call, and asserts the
reply is traceable to retrieved Knowledge Base content, not a model-invented answer.

Source: issue #21, acceptance criterion 5 (`tests/concierge/acceptance/destination-guide-retrieval.spec.ts`).

## REQ-KB-005 — Knowledge Base's infrastructure is fully CDK-provisioned

A Bedrock **Managed** Knowledge Base (`type: MANAGED`, service-managed embedding model — no
vector store to provision), its S3 content bucket (3 authored per-city docs deployed via
`BucketDeployment`), and its S3 data source are provisioned by CDK — no console or bare-CLI
provisioning. The Runtime's own execution role holds `bedrock:Retrieve` on the Knowledge Base's
ARN directly; there is no Gateway target for it. Verified by `cdk synth` succeeding, not an
automated test, same as REQ-GATEWAY-004.

Source: issue #21, acceptance criterion 6; revised by ADR-0010.

## REQ-EVAL-001 — Two AND'd custom evaluators judge itinerary quality

A TOOL_CALL-level deterministic evaluator (`wayfarer_budget_gate`) reads Code Interpreter's
Running total and compares it against the fixed scenario budget (`WAYFARER_SCENARIO_BUDGET_USD`),
AND'd with a SESSION-level LLM-as-a-judge evaluator (`wayfarer_itinerary_quality`) judging
relevant (holds match the Caller's stated destinations/dates/constraints) and complete (all
requested cities end the session with both a flight hold and a hotel hold). A session passes
only if both evaluators return `PASS`/`Pass` — that AND is read from the two separate `Evaluate`
results, not enforced by either evaluator alone.

Source: issue #23, "What to build"; ADR-0007.

## REQ-EVAL-002 — The deterministic gate's scoring logic is exhaustively unit tested

`evaluateBudgetGate`/`extractRunningTotals` (`src/evaluations/budget-gate-evaluator/handler.ts`)
are tested directly, independent of the Lambda's AgentCore event wrapper: finding a Running total
nested as a parsed object or as a serialized JSON string attribute, judging the session's final
(highest) Running total rather than the first one seen, narrowing to `evaluationTarget.spanIds`
when AgentCore supplies one (falling back to every span when none match), and the `NO_BUDGET_DATA`
error path when no span carries Code Interpreter output at all.

Source: issue #23, "write ordinary tests for any deterministic-gate parsing/scoring logic".
Covered by `tests/evaluations/budget-gate-evaluator/handler.spec.ts`.

## REQ-EVAL-003 — Both evaluators are fully CDK-provisioned

The budget-gate Lambda, the TOOL_CALL code-based evaluator, and the SESSION LLM-as-a-judge
evaluator are all provisioned via `aws-cdk-lib`'s `aws-bedrockagentcore` L2 `Evaluator`/
`EvaluatorConfig` constructs — no console or bare-CLI `create-evaluator` call. Verified by `cdk
synth` succeeding, not an automated test, same as REQ-KB-005.

Source: issue #23, "Register both evaluators via create-evaluator... follow this repo's existing
CDK-first convention".

## REQ-EVAL-004 — The evaluation dataset is 3 live-generated transcripts, not hand-authored fixtures

Happy-path, over-budget, and incomplete transcripts are each produced by invoking the real,
deployed Concierge Runtime through its Cognito-authenticated `/invocations` entry point with a
steered multi-turn conversation, exercising the full composed stack (Gateway, Memory, Identity,
Code Interpreter, Browser Tool, Policy, Knowledge Base) exactly as a live Caller would — not
hand-typed OTEL span JSON.

Source: issue #23, acceptance criterion 2; ADR-0007.

## REQ-EVAL-005 — On-demand evaluation against the 3 transcripts matches the expected pass/fail per transcript

Triggering the on-demand `Evaluate` API for both evaluators against each transcript's session
spans, read back from CloudWatch, shows: happy-path passes both gates; over-budget fails only the
deterministic gate; incomplete fails only the LLM-judge gate. Verified manually by reading
CloudWatch evaluation results, per the spec's testing decisions for Evaluations — not an
automated test.

**Fully verified** (ADR-0007's Revision 3): both gates confirmed against real `Evaluate` calls on
the final 3-transcript dataset, matching every expectation exactly —

| Transcript | Budget gate | Judge |
|---|---|---|
| happy | PASS ($3,594.10 ≤ $3,600) | Pass — relevant + complete |
| over-budget | FAIL ($4,061.83 > $3,600) | Pass — relevant + complete |
| incomplete | PASS (not this transcript's tested criterion) | Fail — incomplete (only Tokyo held) |

Getting the judge working against the real (multi-turn) dataset needed two more fixes past
ADR-0007's Revision 2: a split-telemetry event-record pipeline (this account's Runtime delivers
telemetry in "split" mode, needing a second, correlated CloudWatch Logs record per
content-bearing span — REQ-OBS-003 below), and `handler.ts` setting `gen_ai.task.output`
unconditionally rather than only on the successful-reply path (a fallback-message turn's span
was missing that event record's `output` field entirely, failing the whole session's evaluation,
not just that one span).

Source: issue #23, acceptance criteria 3-6.

## REQ-OBS-001 — Every live-Concierge primitive emits its own span, correctly nested under one session span

One live end-to-end session produces one trace with a `session.id`-tagged `InvokeAgent` root span
and, under it, the correct parent/child nesting for every request it makes: Runtime's own session
span, Identity's inbound-auth check, Memory's `get_last_k_turns`/`create_event`/
`RetrieveMemoryRecords` (both Strategies), one `chat <model>` span per model round, one
`execute_tool <name>` span per Gateway booking action (folding Policy's ALLOW/DENY into that same
span — Policy has no AWS call of its own to give it a separate span), Code Interpreter's
`executeCode`, and Browser Tool's `price-check`. Harness (issue #22, standalone) never appears.

Source: issue #24, acceptance criteria 1-2, 5; ADR-0008.

## REQ-OBS-002 — Identity/Code Interpreter/Memory redaction is asymmetric, matching ADR-0008

Only Identity's consent-flow spans redact token/secret values (`redactTokenValue()`, keeping flow
state like `pending`/`approved` visible) — Code Interpreter's budget figures and Memory's
preference facts stay unredacted everywhere else, since neither is a credential and both are the
substance a reviewer needs to judge a session's quality.

Source: issue #24, acceptance criteria 3-4; ADR-0008.

## REQ-OBS-003 — Tracing infrastructure is hand-rolled, not the ADOT auto-instrumentation agent

Because the Concierge's deployed bundle is ESM and the AWS Node ADOT distro's only public entry
point relies on `require()`-patching (silently inert under ESM), spans are emitted by a manual
OpenTelemetry pipeline (`src/concierge/observability/tracing.ts`): `BasicTracerProvider` +
`AWSXRayIdGenerator` + `AsyncHooksContextManager`, exporting via a custom, SigV4-signed
`SpanExporter` POSTing OTLP-protobuf-serialized batches directly to
`https://xray.<region>.amazonaws.com/v1/traces`. The Runtime's execution role holds
`xray:PutTraceSegments`/`PutSpans`/`PutSpansForIndexing`/`PutTelemetryRecords` (`Resource: "*"`,
matching the `AWSXRayDaemonWriteAccess` managed policy's own scoping). Verified by real spans
appearing in the `aws/spans` CloudWatch Logs group with correct trace/span/parent IDs and
`gen_ai.*` attributes — not by an automated test, per the spec's testing decisions for
Observability.

Source: ADR-0008's Revision (issue #24, issue #23's discovery that ADR-0007's "no blocking edge to
Observability" premise was false).

## REQ-OBS-004 — A second, split-telemetry event-record pipeline delivers span content to CloudWatch Logs

This account's Runtime delivers telemetry in AgentCore's "split" mode (confirmed live: setting
`UNIFIED_TRACES_DESTINATION_ENABLED=true` had no effect, since the platform only honors it for a
sender it recognizes as a real ADOT SDK build). Split mode needs each content-bearing span's
payload delivered a second time, as a separate CloudWatch Logs record correlated by `traceId`/
`spanId`, to the Runtime's own log group's `otel-rt-logs` stream — without it, AgentCore
Evaluations' LLM judge fails the whole session with `LogEventMissingException`.
`emitEventRecord()` (`tracing.ts`) writes this via `PutLogEventsCommand`, discovering the log
group at runtime by name (`CONCIERGE_RUNTIME_NAME`) rather than by the Runtime's generated
`agentRuntimeId`, which isn't knowable at CDK synth time without a circular CloudFormation
dependency. New IAM: `logs:DescribeLogGroups`, `logs:CreateLogStream`, `logs:PutLogEvents`.
Delivery is best-effort and silent on failure, matching the Traces exporter's own treatment.

Source: ADR-0007's Revision 3 / ADR-0008's Revision (issue #23).

## REQ-GUARDRAIL-001 — Blanket content-safety protection applies to every Caller turn

A Bedrock Guardrail is attached via `guardrailConfig` (`trace: "disabled"`) to every
`ConverseCommand` call the Concierge makes, not just some of them. It denies four narrow
topics (financial/investment advice, medical/health advice, legal advice, general
non-travel Q&A) without catching travel-relevant health/safety questions or destination
entry-requirement facts; applies `PROMPT_ATTACK`/`MISCONDUCT` content filters at `HIGH`
and `HATE`/`INSULTS`/`SEXUAL`/`VIOLENCE` at `MEDIUM`; and `BLOCK`s exactly four PII entity
types (credit/debit card number, US SSN, US passport number, driver's license/ID),
leaving every other entity type (name, address, phone, email) untouched so Memory's
personalization (REQ-MEMORY-002) keeps working.

Source: issue #26, acceptance criterion 1; revised by ADR-0011.

## REQ-GUARDRAIL-002 — Knowledge Base retrieval content is contextually grounded

A contextual grounding policy (grounding and relevance thresholds both 0.7) is
configured on the guardrail, and a successful `retrieve-destination-guide` tool result
is the only tool result wrapped in `guardContent` blocks — one tagged `grounding_source`
(the retrieved excerpt text) and one tagged `query` (the model's own tool-call query
argument), since a contextual grounding check needs both halves of that pair to run at
all. An errored retrieval, a result with zero excerpts, or an unparseable query is left
unwrapped, since there's no real content to ground against. Every other tool result
(`search-flights`, `search-hotels`, `hold-flight`, `hold-hotel`, `approve-hold`,
`write-calendar-event`) is always left unwrapped — none of them carry independently-
addressable free text; Browser Tool's price-check result in particular is nested inside
`hold-flight`/`hold-hotel`'s own strictly-parsed payload, not its own tool result
(ADR-0011).

Source: issue #26, acceptance criteria 2 and 3; revised by ADR-0011.

## REQ-GUARDRAIL-003 — The guardContent-wrapping decision is a pure, exhaustively unit-tested branch

`toToolResultContentBlocks()` (`src/concierge/adapter/bedrock-converse-model-client.ts`)
is a pure function — `ToolCall` + `ToolCallResult` in, `ContentBlock[]` out, no AWS SDK
call at this seam — exhaustively tested for the one grounded tool name and a
representative case of every other tool name passing through unwrapped.

Source: issue #26, acceptance criterion 4 (`tests/concierge/adapter/bedrock-converse-model-client.spec.ts`).

## REQ-GUARDRAIL-004 — The Guardrail is enforced by IAM, not just application code

The Runtime's own execution role holds `bedrock:ApplyGuardrail` scoped to the guardrail's
ARN (required for any Converse call carrying `guardrailConfig`, confirmed live — a
Converse call fails with `AccessDeniedException` without it, distinct from and in
addition to `bedrock:InvokeModel` on the foundation model), plus an explicit `Deny` on
`bedrock:InvokeModel`/`InvokeModelWithResponseStream`, keyed on
`bedrock:GuardrailIdentifier` `StringNotEquals` this guardrail's pinned `arn:...:version`
— attached to the Concierge Runtime's own execution role only, not account- or org-wide
— so a future code change that drops `guardrailConfig` fails closed instead of silently
invoking the model unguarded.

Source: issue #26, acceptance criterion 5.

## REQ-GUARDRAIL-005 — The Guardrail's infrastructure is fully CDK-provisioned, with a pinned numbered version

A `CfnGuardrail` (content filters, denied topics, sensitive-information policy,
contextual grounding policy) plus a separate `CfnGuardrailVersion` pinning a numbered
version (never `DRAFT`) are provisioned by CDK — no L2 construct exists for this in the
installed `aws-cdk-lib` version, so `GuardrailConstruct` is built directly against the
two L1s, matching this project's CDK-first convention. Verified by `cdk synth`
succeeding, not an automated test, same as REQ-KB-005. Live-verified post-deploy against
the real Runtime with three probes (an off-topic ask, a fake credit-card-shaped number,
and a Knowledge-Base-grounded destination question), each confirmed via CloudWatch — a
manual step following this project's existing manual-changeset deploy flow, not an
automated test.

Source: issue #26, acceptance criteria 6, 7, and 8.

## REQ-HARNESS-001 — The comparison build completes the same search+hold beat as Gateway, invoked directly via InvokeHarness

`InvokeHarness` against the standalone comparison Harness completes the same 3-city
search-then-hold beat as the Concierge (REQ-GATEWAY-003), using the same booking Gateway
target — the Harness's `agentcore_gateway` tool executes against the Gateway entirely on
AWS's side, so this build owns no client-side tool-execution loop of its own. Verified by
an acceptance test invoking `InvokeHarness` directly, with only the `BedrockAgentCoreClient`
network boundary mocked (there is no client-observable HTTP call to intercept for the
server-side Gateway hop).

Source: issue #22, acceptance criteria 1 and 4.

## REQ-HARNESS-002 — A per-invocation model override changes which model serves a call, with no redeploy

`InvokeHarnessCommand`'s own `model` field, left unset, lets a call fall back to the
Harness resource's stored declarative model config; set on one call only, it serves that
call from a different Bedrock model while every other call keeps using the Harness's
stored default — the Harness resource itself is never recreated or redeployed between the
two calls.

Source: issue #22, acceptance criterion 2.

## REQ-HARNESS-003 — The comparison build is entirely separate from the Concierge's composition root and deployment

The comparison Harness lives in its own CDK stack (`HarnessComparisonStack`) and bin entry
(`infra/cdk/bin/harness-comparison-app.ts`), deployed by hand via
`npm run deploy:harness-comparison` and never part of `npm run deploy`'s `ConciergeStack`.
It references the already-deployed booking Gateway only by ARN (`ConciergeStack`'s own
`GatewayArn` output, passed via CDK context), never by importing `ConciergeStack`'s CDK
constructs — no shared runtime path with the live Concierge. Verified by `cdk synth`
succeeding against `harness-comparison-app.ts` in isolation, not an automated test, same as
REQ-GATEWAY-004.

Source: issue #22, acceptance criterion 3; ADR-0002.

## Changelog

- 2026-08-28 — Added REQ-RUNTIME-001, REQ-RUNTIME-002, REQ-RUNTIME-003 for the Runtime
  walking skeleton (issue #14). First requirements in this PRD.
- 2026-08-28 — Added REQ-GATEWAY-001 through REQ-GATEWAY-004 for Gateway's booking
  target (issue #15): search/hold tool contracts, the search-then-hold vertical slice,
  and CDK provisioning of the mock Lambda + Gateway target.
- 2026-09-01 — Added REQ-MEMORY-001 and REQ-MEMORY-002 for Memory's scratch state and
  long-term preference recall (issue #16). The Runtime walking skeleton's in-memory
  `ConversationRepository`/`InMemoryConversationRepository` placeholder (issue #14) is
  removed, replaced by a real `MemoryPort`/`AgentCoreMemoryAdapter` backed by
  create_event/get_last_k_turns/RetrieveMemoryRecords — REQ-RUNTIME-002 continues to
  hold, now backed by Memory's session scoping rather than an in-process Map.
- 2026-09-01 — Added REQ-IDENTITY-001 through REQ-IDENTITY-007 for Cognito inbound auth and the
  delegated calendar consent handshake (issue #17). Issue #16's `PLACEHOLDER_ACTOR_ID` is removed;
  actorId is now derived from the inbound JWT's `sub` claim on every invocation
  (`CognitoJwtVerifier`, `infra/handler.ts`). A new Concierge-owned `write-calendar-event` tool
  (not a Gateway target) is dispatched via a `CompositeToolExecutor` alongside issue #15's booking
  tools.
- 2026-09-05 — Added REQ-CODEINTERPRETER-001 through REQ-CODEINTERPRETER-007 for Code Interpreter's
  budget/currency math (issue #18 / ADR-0004). `BookingToolExecutor` stays the same long-lived
  singleton it always was (still wired once in composition-root.ts) and now caches each search's
  candidates by candidateId, so a hold in the same or a later conversation turn can recover the
  Local price/city/category to convert; `ToolExecutor.execute`/`ModelClient.generateReply` both
  gained a `sessionId` parameter so Code Interpreter's per-conversation sandbox session can be keyed
  by it without rebuilding the executor per call.
- 2026-09-05 — Added REQ-BROWSERTOOL-001 through REQ-BROWSERTOOL-007 for Browser Tool's live
  price-check before every hold (issue #19 / ADR-0005). `BookingToolExecutor` now runs a
  `PriceCheckPort` check for every cached candidate immediately before Gateway's hold call, blocking
  the hold on failure; the resulting Live price (not Quoted) is what gets held, surfaced in the tool
  result's new `livePrice` field, and passed to `BudgetPort.recordHold` — revising
  REQ-CODEINTERPRETER-002/003's conversion input from issue #18. A new `BrowserToolPriceCheckAdapter`
  and a CDK-provisioned mock price-check site (S3 static website) + `BrowserCustom` resource back it.
- 2026-09-06 — Revised REQ-BROWSERTOOL-007: a real deploy showed AgentCore's managed Browser Tool
  blocks navigation to `s3-website-*.amazonaws.com` hostnames outright (`net::ERR_BLOCKED_BY_CLIENT`,
  a built-in anti-abuse default, not a bug in this repo's code) — S3 static website hosting was
  removed from `PriceCheckSiteConstruct`, the site now served from S3's plain REST/object endpoint
  (`bucketRegionalDomainName`), confirmed working against the live deployed Browser Tool resource.
- 2026-09-06 — Revised REQ-BROWSERTOOL-007 again: the real deploy's first hold attempt after the S3
  endpoint fix above still 403'd — `BrowserCustomBase.grantUse()` only grants
  `StartBrowserSession`/`UpdateBrowserStream`/`StopBrowserSession`, not
  `ConnectBrowserAutomationStream`, which the CDP connection `PlaywrightBrowser.navigate()` actually
  makes needs. `concierge-stack.ts` now grants that action explicitly alongside `grantUse()`.
- 2026-09-05 — Added REQ-POLICY-001 through REQ-POLICY-007 for Policy's Cedar approval gate on
  expensive holds (issue #20 / ADR-0006). Gateway's booking target gains a fifth action,
  `approve-hold` (no side effect beyond the Gateway response event Policy's temporal rule
  matches against); `hold-flight`/`hold-hotel` gain an optional `price` input field (the Live
  price BookingToolExecutor already caches from the price-check, issue #19) so Cedar's flat
  threshold can evaluate `context.input.price` at the Gateway boundary — the model itself never
  supplies it. `BookingGatewayPort.holdFlight`/`holdHotel`/`approveHold` gained a `sessionId`
  parameter carried as the `x-amzn-bedrock-agentcore-policy-session-id` header, correlating a
  Caller's `approve-hold` event with their own later hold in the same Runtime session's Cedar
  trajectory. A Policy denial surfaces over MCP as an ordinary `isError` tool response bearing
  `AuthorizeActionException` text (not a distinct wire-level error); `BookingGatewayAdapter`
  translates that into `GatewayError`'s new `HoldGated` variant, which `BookingToolExecutor`
  turns into a tool result carrying the Live price and asking the model to request the Caller's
  approval — the same "not authorized yet, here's what to do" shape as Identity's
  `ConsentRequired` (issue #17). The Policy engine denies by default across every action on the
  Gateway it's attached to, not just the ones a policy targets, so an unconditional
  `wayfarer_search_unrestricted` Cedar policy permits `search-flights`/`search-hotels` — without
  it, ENFORCE mode would silently deny the read-only search tools issue #15 already shipped.
- 2026-09-08 — Added REQ-KB-001 through REQ-KB-005 for Knowledge Base's destination-guide
  retrieval via Gateway (issue #21 / ADR-0009). A Bedrock Managed Knowledge Base, fronted by a
  second, distinct Gateway target using AgentCore's native `bedrock-knowledge-bases` connector
  (not a Lambda/OpenAPI target like issue #15's booking target), exposes a `Retrieve` MCP tool.
  The Concierge's own `retrieve-destination-guide` tool (`KnowledgeBaseToolExecutor`,
  `KnowledgeBaseGatewayAdapter`) wraps that connector's nested `retrievalQuery.text` wire shape
  behind a flat `query` argument, the same translation pattern `BookingToolExecutor` already
  uses for its own tools. Read-only and ungated: an unconditional Cedar policy on the shared
  Policy engine (attached to the same booking Gateway, ENFORCE mode) permits the `retrieve`
  action, mirroring `wayfarer_search_unrestricted` from issue #20 — without it, ENFORCE mode
  would silently deny this new action too, the same reasoning that already applies to
  search-flights/search-hotels.
- 2026-09-08 — Revised REQ-KB-003, REQ-KB-004, and REQ-KB-005 (issue #21 / ADR-0010).
  Destination-guide retrieval no longer goes through a Gateway target: `BedrockKnowledgeBaseAdapter`
  calls `bedrock-agent-runtime`'s `Retrieve` API directly, and the Runtime's own execution role
  holds `bedrock:Retrieve` on the Knowledge Base's ARN. `KnowledgeBaseGatewayTargetConstruct`, its
  Cedar policy (`wayfarer_destination_guides_unrestricted`), and the Gateway-role grant it added are
  all removed — REQ-KB-003's ungated requirement is now met by having no mediating layer at all,
  not by an unconditional Cedar permit. REQ-KB-001 and REQ-KB-002 are unaffected.
- 2026-09-08 — Added REQ-EVAL-001 through REQ-EVAL-005 for Evaluations' itinerary-quality gates
  (issue #23 / ADR-0007). `aws-cdk-lib`'s `aws-bedrockagentcore` module ships a full L2
  `Evaluator`/`EvaluatorConfig` construct pair (not just the L1 `CfnEvaluator` already used for
  Policy) — both the TOOL_CALL code-based evaluator and the SESSION LLM-as-a-judge evaluator are
  CDK-provisioned with no CLI fallback needed, unlike ADR-0007's original "fall back to
  CLI/SDK" contingency. `EvaluatorConfig.codeBased()` auto-grants the evaluation service invoke
  permission on the Lambda scoped to that evaluator's own ARN, so no manual IAM wiring was needed
  the way `BookingGatewayConstruct`'s Gateway-to-router-Lambda grant was.
- 2026-09-09 — Added REQ-OBS-001 through REQ-OBS-003 for full-session tracing across every
  live-Concierge primitive (issue #24 / ADR-0008, revised). Picked up out of build order, ahead of
  its own place in the spec's "Observability... last" sequencing, because implementing #23 (issue
  #23 / ADR-0007) discovered live that Evaluations' on-demand `Evaluate` step genuinely depends on
  real OTEL spans existing — reversing ADR-0007's original "no blocking edge to Observability"
  claim. `BookingGatewayAdapter`, `AgentCoreMemoryAdapter`, `CodeInterpreterBudgetAdapter`,
  `BrowserToolPriceCheckAdapter`, `DelegatedCalendarAdapter`, and `BedrockKnowledgeBaseAdapter`
  each gained a `withSpan()` wrapper around their one real AWS call;
  `BookingGatewayPort.searchFlights`/`searchHotels`/`holdFlight`/`holdHotel`/`approveHold`'s
  previously-unused `_sessionId` parameters are now used (for the span attribute only — still
  never forwarded to Gateway itself, per issue #20's header finding).
- 2026-09-09 — Revised REQ-EVAL-005 (issue #23 / ADR-0007's Revision 2). With #24's spans
  landing in CloudWatch, the real on-demand `Evaluate` run surfaced two more AgentCore-internal
  requirements specific to the SESSION LLM-as-a-judge evaluator: spans must carry a
  `scope.name` from a fixed allow-list of known agent frameworks (fixed by labeling the tracer
  `opentelemetry.instrumentation.langchain` — a compatibility label, not a framework claim,
  since our span shape already matches what that scope emits), and every span needs a
  `traceloop.span.kind` attribute (`llm`/`tool`/`workflow`) the judge uses to find "model/tool/
  agent invocation details." Both fixed and confirmed live. The deterministic gate is now fully
  verified against the real 3-transcript dataset (exact PASS/FAIL matches); the LLM judge works
  in isolation but not yet against the multi-turn dataset (`LogEventMissingException` — needs a
  second, Logs-signal OTEL pipeline alongside the Traces one this ADR built), left as a follow-up.
- 2026-09-09 — Added REQ-OBS-004 and fully resolved REQ-EVAL-005 (issue #23 / ADR-0007's
  Revision 3, ADR-0008's Revision). Two more fixes closed the gap the previous entry left open:
  (1) `UNIFIED_TRACES_DESTINATION_ENABLED=true` was tried first and didn't work — the platform
  only honors it for a real ADOT SDK sender, which a hand-rolled tracer isn't — so a genuine
  split-telemetry event-record pipeline shipped instead (`emitEventRecord()`, `tracing.ts`,
  writing to the Runtime's own log group's `otel-rt-logs` stream, discovered at runtime by name
  to avoid a circular CDK dependency on the Runtime's own generated ID); (2) `handler.ts`'s
  `gen_ai.task.output` attribute was only set on the successful-reply path — the three fallback-
  message early returns skipped it, and every real transcript has at least one such turn (a
  `ModelError` from exceeding `MAX_TOOL_USE_ROUNDS`, always retried), so `handler.ts` was
  restructured to set it unconditionally from a single exit point. With both fixed, the final
  3-transcript dataset (regenerated once more so every span postdates both fixes) matches all 6
  of issue #23's acceptance criteria exactly — both gates, all three transcripts.
- 2026-09-09 — Added REQ-GUARDRAIL-001 through REQ-GUARDRAIL-005 for the Bedrock Guardrail
  applied to the Concierge's own Converse calls (issue #26 / ADR-0011): blanket content-safety
  protection on every Caller turn, contextual grounding scoped to Knowledge Base retrieval only
  (not Browser Tool's price-check, which is nested inside hold-flight/hold-hotel's own payload,
  not its own tool result), IAM-enforced via a `bedrock:GuardrailIdentifier` Deny on the Runtime's
  own execution role, and a pinned numbered guardrail version provisioned by CDK's `CfnGuardrail`/
  `CfnGuardrailVersion` L1s (no L2 exists).
- 2026-09-09 — Deployed the Guardrail (issue #26 / ADR-0011) and live-verified all three
  probes against the real Runtime. The real `CreateGuardrail` call surfaced two config
  errors the AWS API docs don't make obvious up front (`PROMPT_ATTACK`'s `outputStrength`
  must be `NONE`; denied-topic `definition`s are capped at 200 characters and must avoid
  negative/exception framing — the original "not to be confused with..." clauses were
  rewritten to scope each topic to a *personal* matter instead, same carve-out, no
  exclusion language). Once deployed, the first real Converse call still failed
  (`AccessDeniedException` on `bedrock:ApplyGuardrail`) — a Converse call carrying
  `guardrailConfig` needs that grant on the guardrail's own ARN, separate from
  `bedrock:InvokeModel` on the foundation model; added to `ConciergeStack`. With both
  fixed, all three probes (denied-topic block, PII block, KB-grounded destination answer)
  passed against the deployed Runtime, confirmed via CloudWatch — REQ-GUARDRAIL-004 and
  REQ-GUARDRAIL-005 are now fully verified, not just synth-checked.
- 2026-09-09 — Added REQ-HARNESS-001 through REQ-HARNESS-003 for Harness's standalone
  comparison build (issue #22 / ADR-0002): the same 3-city search+hold beat as Gateway
  (REQ-GATEWAY-003), reimplemented as pure declarative Harness config
  (`HarnessComparisonConstruct`'s `CfnHarness`) and invoked via a thin
  `invokeSearchAndHoldBeat` wrapper around `InvokeHarness` — no client-side tool-execution
  loop, since the Harness's `agentcore_gateway` tool calls the booking Gateway entirely on
  AWS's side. Lives in its own `HarnessComparisonStack`/bin entry, deployed by hand and
  never wired into `ConciergeStack` or its deployment; `ConciergeStack` gained a `GatewayArn`
  output so the comparison stack can reference the booking Gateway by ARN alone.

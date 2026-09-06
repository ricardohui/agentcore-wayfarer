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

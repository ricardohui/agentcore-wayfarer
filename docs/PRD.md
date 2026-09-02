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

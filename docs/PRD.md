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

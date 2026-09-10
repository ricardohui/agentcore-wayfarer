# Context: agentcore-wayfarer

## Wayfarer

The scenario anchoring this project: an AI travel-planning concierge that plans and
partially books a multi-city trip for a returning user, across multiple conversations,
touching a real external calendar, paying per-call for premium data, and getting fully
traced end to end. Chosen so every AgentCore primitive in scope is load-bearing in one
coherent story rather than a disconnected toy demo per primitive.

## Scenario city

One of Wayfarer's 3 fixed cities the trip-planning scenario searches and holds
against: **Tokyo, Paris, New York**. Picked while building Gateway's booking
target (issue #15) — no other ticket had named them. Every `search-flights`/
`search-hotels` candidate and Knowledge Base destination guide is scoped to
one of these three; the set is fixed, not Caller-chosen.
_Avoid_: Destination (bare) — Scenario city names the fixed 3-city set this
project uses, not any city a real Caller could name.

## Primitive

One of the 10 Amazon Bedrock AgentCore capabilities in scope for Wayfarer, all GA as of
2026-08-28: Runtime, Gateway, Memory, Identity, Code Interpreter, Browser Tool,
Observability, Harness, Policy, Evaluations.

Registry and Payments (x402 / Machine Payment Protocol) are explicitly out of scope —
no real discovery/cataloging need in a single-user learning scenario, and Payments
isn't a priority for this learning pass.

Not every AWS capability Wayfarer touches is a Primitive in this sense — see Knowledge
Base, a Bedrock capability the Concierge calls directly rather than counted as an
11th primitive of its own.

## Knowledge Base

Wayfarer's RAG capability: a Bedrock **Managed** Knowledge Base (fully managed by
Bedrock — no vector-store infra to provision) holding destination-guide content
(visa/entry requirements, climate, customs, packing advice) for the 3 scenario cities,
queried by the Concierge via a direct in-process `bedrock-agent-runtime` Retrieve call
(ADR-0010) — no Gateway hop. Content is authored (not crawled or real-sourced) and
ingested via the Knowledge Base's own S3 data source, same mock-the-outside-world
spirit as ADR-0001/0004/0005. Read-only and ungated — no Policy consequence, same
treatment as search-flights/search-hotels.
_Avoid_: calling this a 12th "Primitive" — see Primitive, above. Also avoid "RAG" bare
as a glossary term — always say Knowledge Base, the concrete AWS resource.

## Guardrail

A Bedrock Guardrail applied to the Concierge's own Converse calls (issue #26 /
ADR-0011) — blanket protection (`guardrailConfig`) on every Caller turn, plus
selective `guardContent` wrapping around the one tool result that carries
genuinely external-sourced free text: Knowledge Base retrieval. Every other
tool result is left unwrapped, including Browser Tool's price-check — its
Live price is nested inside `hold-flight`/`hold-hotel`'s own strictly-parsed
`{amount, currency}` payload, not an independently-addressable tool result. A
model-invocation capability, not an AgentCore primitive — see Primitive,
above.
_Avoid_: calling this a "Primitive" — same caution as Knowledge Base; it's
applied at the Bedrock Converse layer inside Runtime, not a primitive of
its own. Also avoid assuming Browser Tool's price-check gets the same
`guardContent` treatment as Knowledge Base — it doesn't (see above).

## Scenario beat

A concrete moment in Wayfarer's user journey (e.g. "user asks to plan a 3-city trip",
"agent writes a calendar event confirming a held booking") that a primitive's design
decision must serve. Keeps each primitive's ticket concrete rather than an abstract tour
of the primitive's API surface.

## Gateway Target

The AgentCore Gateway configuration that exposes Wayfarer's booking-domain
actions as MCP tools: one OpenAPI schema, one router Lambda dispatching by
operation, `lambda_iam` auth. Scoped to search/hold actions only — currency
conversion belongs to the Code Interpreter primitive, live price-checking to
the Browser Tool primitive.

## Hold

A tentative, time-limited reservation of a specific flight or hotel option,
created by the `hold-flight`/`hold-hotel` Gateway tools. Carries a
`holdId`, `status`, and `expiresAt`. Not a finalized booking.
_Avoid_: Booking, reservation (imply a finalized transaction)

## Concierge

The single live Wayfarer application: a custom Node.js handler wrapped in
`BedrockAgentCoreApp`, deployed to AgentCore Runtime. The thing a returning
user actually talks to, across sessions.
_Avoid_: Agent (too generic — several primitives in this project produce
agent-shaped things; Concierge names the one that ships)

## Comparison build

A standalone, throwaway implementation of a single scenario beat on a
primitive the Concierge itself doesn't use — built purely to teach that
primitive's mechanics against a beat already defined elsewhere, never wired
into Wayfarer's live architecture. Harness's learning task (issue #4) is the
first instance: the Gateway search+hold beat reimplemented as pure Harness
config, compared against the Concierge's custom-code approach.
_Avoid_: Demo, prototype (this project's Prototype ticket type already names
a different thing — a HITL fidelity-raising artifact)

## Actor

The AgentCore Memory identity a long-term fact is scoped to (`actorId`),
distinct from Runtime's `runtimeSessionId`. Wayfarer sets actorId to the
Caller's Cognito `sub` — the returning user is whoever the inbound identity
says they are, not a separate Memory-only concept.
_Avoid_: User, session (actor persists across sessions; a session is one
conversation, an actor is who's having it)

## Caller

The identity of whoever is talking to the Concierge, established by
Runtime's inbound JWT authorizer validating a Cognito-issued token.
Wayfarer's single source of "who is this" — Actor (Memory) is this same
identity referenced in a different role, not a second identity.
_Avoid_: User (too generic — Caller specifically means "the authenticated
inbound identity," not the human in the abstract)

## Delegated credential

An OAuth token AgentCore Identity holds in its token vault on the
Concierge's behalf, letting it act against an external API (Wayfarer's
calendar) as the Caller without the Caller's password ever passing through
the agent. Obtained via a consent handshake, not present until the Caller
grants it.
_Avoid_: Access token (bare) — Delegated credential names its role
(acting *for* the Caller), not just its shape

## Consent handshake

The interaction where a Delegated credential is first obtained: the
Concierge's first attempt to use it fails, it surfaces an authorization
URL to the Caller mid-conversation, the Caller approves out-of-band, and
the Concierge's retry succeeds once the token vault holds a valid token.
Happens at most once per Caller per external target, not per session.
_Avoid_: Login, sign-in (this is the Concierge obtaining delegated access,
not the Caller authenticating to Wayfarer — that's the inbound JWT layer)

## Memory Strategy

A configured AgentCore Memory extractor that turns short-term events into
long-term memory records under a namespace. Wayfarer configures two:
`user-preference` (stable facts — home airport, seat/dietary prefs) and
`semantic` (soft free-form preferences surfaced from conversation, e.g.
"avoids red-eyes").
_Avoid_: Strategy (bare) — always qualify as Memory Strategy to avoid
confusion with an implementation pattern

## Scratch state

In-progress, session-scoped trip-planning state (candidate destinations,
running budget) held via AgentCore Memory's short-term memory
(`create_event`/`get_last_k_turns`). Dies with the session — a fresh
session starts a fresh trip in Wayfarer's scope; scratch state never
survives into a Memory Strategy.
_Avoid_: Session state (too close to Runtime's own per-session working
state, which is Runtime's ephemeral microVM state, not Memory's)

## Local currency / Home currency

The currency a Gateway search result prices in (Local — e.g. a Tokyo hotel
priced in JPY) versus the fixed currency the traveler budgets in (Home —
USD for Wayfarer). Every held item's price starts in its Local currency and
is converted to Home currency before it contributes to the Running total.
_Avoid_: Currency (bare) — always say which side of the conversion you mean

## Running total

The accumulating Home-currency sum of all held items in the current trip,
kept as Code Interpreter session state and updated once per successful
hold. Distinct from Scratch state (Memory's short-term store) — the
Running total lives in Code Interpreter's own execution state, not Memory.
_Avoid_: Budget (Wayfarer never enforces a spending cap — Running total is
observational, not a constraint)

## Budget breakdown

The Running total sliced two ways — by city and by category (flights vs
hotels) — recomputed alongside the Running total on each hold.

## Price-check

The Browser Tool step where the Concierge navigates a mock price-check site
for a held candidate and reads its live price, run once per candidate
immediately before its hold-flight/hold-hotel call.
_Avoid_: Price comparison, verification (imply checking against multiple
sources or validating correctness — Price-check reports one live figure, no
comparison happens beyond what the Concierge tells the Caller)

## Quoted price / Live price

Quoted price is a search result's price from Gateway's mock catalog (issue
#3). Live price is the figure a Price-check reads from the mock
price-check site for a specific candidate — randomized independently of
Gateway's data, so it can diverge from Quoted price. The Running total is
computed from Live price; Quoted price never itself flows into the Running
total.
_Avoid_: Price (bare) — always say which stage of the flow you mean

## Approve-hold

A generic Gateway action (added to Gateway's existing target, revising issue
#3) whose sole purpose is marking the Caller's session approved, so a
subsequent hold-flight/hold-hotel retry can carry `approved: true` for
Policy's approved-retry Cedar rule to match. Not itself a booking action —
carries no side effect beyond that. One-time consumption (a second,
unrelated hold can't reuse the approval) is enforced by the Concierge, which
clears the session's approval after one successful gated hold — not by
Policy (issue #20, revised: the original design used a Dogwood temporal
rule for this, blocked by an AWS platform bug).
_Avoid_: Confirm, authorize (bare) — Approve-hold names the specific Gateway
action, not the general concept of the Caller agreeing

## Gated hold

A hold-flight/hold-hotel call whose Local-currency price exceeds Policy's
flat threshold, DENYed unless the request itself carries `approved: true`
(set by the Concierge after an Approve-hold call). Both the threshold and
approved-retry rules are stateless, per-request Cedar. Below threshold,
holds pass without an approval step.

## Course outline

The sequence of resolved wayfinder tickets on the Wayfarer map, each pairing one
primitive with its scenario beat and the learning task for building it. This sequence
is itself the teaching artifact — there is no separate teaching-doc deliverable per
ticket. It is the direct input to the `to-spec` → `to-tickets` → `/implement` pipeline
that follows the map.

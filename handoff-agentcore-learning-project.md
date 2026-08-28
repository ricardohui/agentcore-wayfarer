# Handoff: AWS AgentCore Learning Project ("Wayfarer")

## Why this doc exists

Prior session used `~/Developer/ai-sdk-bedrock-demo` (a Next.js + pnpm repo) to learn the
Vercel AI SDK against AWS Bedrock, one feature-page at a time, via a wayfinder map:
[AI SDK on Bedrock — feature demo](https://github.com/ricardohui/ai-sdk-bedrock-demo/issues/1).
That map's pattern: each child ticket both **decided** something and **built** the vertical
slice for it (see the map's "Execution carried into the map" Note), closing with a commit
hash referenced in the ticket and in the map's Decisions-so-far.

The user now wants a **different** project and a **different** rhythm:

- Subject: **AWS Bedrock AgentCore**, not the AI SDK — cover every feature/primitive it offers.
- New, separate working directory/repo. Not a continuation of `ai-sdk-bedrock-demo`.
- Explicit complaint about the prior project's shape: scaffolding the whole app skeleton up
  front (nav shell + stub pages, done in the prior repo's walking-skeleton ticket,
  [issues/3](https://github.com/ricardohui/ai-sdk-bedrock-demo/issues/3)) felt wrong for a
  *learning* project. Don't repeat that — build one primitive at a time, nothing scaffolded
  ahead of when it's needed.
- New requirement not present in the prior project: **when a step is completed, produce a
  teaching-materials artifact that primes the next step**, before moving on. This is a
  required output of finishing a step, not optional documentation written at the end.

## Scenario to build toward: "Wayfarer" — an AI travel-planning concierge

Picked to make every AgentCore primitive load-bearing rather than a disconnected toy demo.
The concierge plans and partially books a multi-city trip for a returning user, across
multiple conversations, touching a real external calendar, paying per-call for premium data,
and getting fully traced end to end.

| AgentCore primitive | Role in Wayfarer |
|---|---|
| **Runtime** | Hosts the agent as a persistent, session-isolated service the user returns to across multiple planning conversations, instead of a stateless single-shot call. |
| **Gateway** | Exposes flight-search / hotel-search / currency-convert as discoverable MCP tools (backed by Lambda or existing APIs) instead of hardcoded tool defs in the agent process. |
| **Memory** | Short-term: scratch state within one planning session (destinations under consideration, budget so far). Long-term: remembers the user's home airport, seat/dietary prefs, and past trips across sessions. |
| **Identity** | Inbound: who's allowed to call this agent. Outbound/delegated: agent acts on the user's behalf against a real (or mocked) calendar API via OAuth to check/hold travel dates. |
| **Code Interpreter** | Sandboxed computation for multi-currency budget totals and a spending breakdown — real math, not the model guessing arithmetic. |
| **Browser Tool** | Sandboxed browser automation to check live prices on a travel site that has no API (or a mock site built for the demo). |
| **Payments** | Agent pays per-call for a premium forex-rate or weather API via x402 micropayments, and/or completes a mock "hold the booking" payment step. |
| **Observability** | Full trace across one planning conversation: every tool call, memory read/write, external API/browser session, in CloudWatch GenAI Observability. |

## Known AgentCore primitives (verify before building — do not build from this list alone)

As of the prior session's general knowledge, AgentCore's primitives are roughly: Runtime,
Gateway, Memory, Identity, Observability, Code Interpreter, Browser Tool, and Payments
(x402 protocol; Payment Manager/Connector/Instrument; Coinbase CDP / Stripe Privy rails).
This service area moves fast and the exact feature set/API shape may have changed. **Load the
`amazon-bedrock` skill and check current AWS docs before treating any of this as ground
truth** — this table is a starting hypothesis for scoping the map, not a spec.

## Recommended workflow

1. New empty directory/repo (not `ai-sdk-bedrock-demo`).
2. If no issue tracker is configured there yet, run `/setup-matt-pocock-skills` first.
3. Run `/wayfinder` to chart the map. Suggested **Destination**: "Wayfarer, a travel-planning
   concierge exercising every current AgentCore primitive, built and taught one primitive at
   a time." Suggested **Notes** to seed the map with:
   - Teaching requirement: closing a ticket must also produce a teaching artifact aimed at
     whoever picks up the *next* ticket — written the way the prior project's execution notes
     were written (see the Decisions-so-far entries on
     [issue #1](https://github.com/ricardohui/ai-sdk-bedrock-demo/issues/1) for the tone/level
     of detail to aim for), but as a standalone doc, not just a resolution comment.
   - No upfront app-shell scaffolding — each ticket builds only what its primitive needs;
     shared plumbing gets extracted only once a second ticket actually needs it (rule of
     three / boy-scout rule from the user's global CLAUDE.md, not a special case for this
     project).
   - AWS infra via CDK only, hyphens not em-dashes in AWS resource names/descriptions
     (carried from the user's global AWS guidance).
   - Load `amazon-bedrock` skill before writing any AgentCore-specific code or config.
   - Route any credential/API-key/token work (OAuth client secrets, payment provider keys)
     through the `aws-secrets-manager` skill — never inline, never fetched directly.
   - Don't assume the prior project's TypeScript/Next.js/pnpm stack carries over — AgentCore's
     idiomatic tooling (e.g. the Python `bedrock-agentcore` SDK / Strands Agents) may fit
     better; make the language/framework choice an explicit early ticket, not an inherited
     default.
4. Order tickets roughly foundational-first: Runtime and Gateway before Memory and Identity,
   Observability last since it wraps everything else and benefits from having real traffic
   to observe.
5. Each ticket close-out: commit the code, write and commit the teaching artifact for the
   *next* concept, then record the resolution on the map per the wayfinder skill (comment +
   close + Decisions-so-far entry) — same mechanics the prior project used, just with the
   added teaching-doc artifact as part of every resolution.

## Open questions to resolve early (candidate first tickets, not decisions)

- Which AgentCore primitives are GA vs. preview right now — confirms scenario feasibility
  before committing any scenario beat to one of them.
- Payments settlement rail: Coinbase CDP vs. Stripe Privy — pick one, don't build both.
- Identity: real OAuth against a real calendar provider (more realistic, more setup friction —
  likely a `/wizard`-shaped human-only step) vs. a mocked delegated-auth target (faster to
  build, less representative of the real primitive).
- Same AWS account as the prior project (757379862009, us-east-1) or a fresh one — ask the
  user, don't assume reuse.
- Language/framework for the agent process itself (see Notes above).

## Suggested skills for the next agent

- **wayfinder** — chart the map and work it, per the workflow above.
- **amazon-bedrock** — load before any AgentCore-specific code, config, or troubleshooting;
  also the source of truth on AgentCore Payments specifics.
- **research** — spin up as AFK tickets to pin down fast-moving AgentCore API/feature details
  before building against them.
- **aws-cdk** — all infrastructure provisioning.
- **aws-secrets-manager** — required before any credential/token/API-key handling.
- **grilling** / **domain-modeling** — pulled in automatically by wayfinder for naming the
  destination and mapping the fog; no need to invoke directly unless bypassing wayfinder for
  a single ticket's discussion.
- **teach** — built for exactly "learn a concept over multiple sessions using the working
  directory as a stateful workspace." Worth comparing against the hand-rolled
  teaching-artifact-per-ticket approach above before committing to one — `/teach` might
  already do what the user is asking for, more cheaply than folding it into wayfinder tickets.
- **setup-matt-pocock-skills** — only if the new working directory has no tracker configured.

## Redactions

None. No credentials, API keys, or personal data appeared in the source conversation.

# Knowledge Base rides a Managed KB behind a new Gateway connector target, not a classic KB or an in-process bypass

> Superseded by ADR-0010: destination-guide retrieval no longer goes through a
> Gateway target. The Managed-KB-over-classic-KB choice below still stands;
> only the Gateway-vs-direct-call choice was reversed.

Wayfarer's Concierge (issue #12) needed a way to ground answers in retrieval-augmented
data. Research (`docs/research/agentcore-knowledge-base-access.md`) surfaced a
prerequisite fact that decides most of this ticket by itself: AWS ships two distinct
Knowledge Base products, and only the newer one — Bedrock **Managed** Knowledge Base
(GA July 2026) — has a native AgentCore Gateway connector target
(`bedrock-knowledge-bases`). The older customer-managed/classic KB has no native
Gateway target at all ("AgentCore Gateway integration: Not supported" per AWS's own
comparison table) and would need a hand-rolled Lambda target instead. We considered
that classic-KB-plus-Lambda path — it's the better-documented, more battle-tested one —
and rejected it because it adds an extra Lambda purely to work around a gap the newer
product doesn't have; Managed KB's native connector needs no Lambda glue at all, at the
cost of being a ~1-month-old GA feature with thin real-world mileage. We also considered
bypassing Gateway entirely with a direct in-process `bedrock-agent-runtime` call — AWS
explicitly sanctions this as standalone usage — and rejected it because it would break
Wayfarer's established pattern (ADR-0001 onward) of routing every Concierge tool through
Gateway.

The Knowledge Base holds destination-guide content only (visa/entry requirements,
climate, customs, packing advice) for the 3 scenario cities — not corporate travel
policy, which was considered as a deliberate contrast with Policy's Cedar rules
(ADR-0006: KB as citable advice vs. Policy as an enforced gate) but dropped to keep this
ticket's content surface to one domain. Content is authored, not crawled or pulled from
a real destination-guide source — same mock-the-outside-world-keep-AgentCore-real
pattern as ADR-0001/0004/0005 — and ingested via the Knowledge Base's S3 connector
(one doc per scenario city, uploaded to a CDK-managed bucket). We considered the Web
Crawler connector, mirroring Browser Tool's real-URL pattern (ADR-0005), and rejected
it: Browser Tool needs a live URL because it browses at conversation *runtime*, but KB
ingestion is a one-time batch step, so crawling a self-hosted site would add
infrastructure (a deployed static site) for no ingestion-time benefit over uploading
the docs straight to S3.

The resulting retrieve tool is a second, distinct Gateway target alongside ADR-0001's
booking OpenAPI/Lambda target — read-only, ungated (no Policy consequence, same
treatment as search-flights/search-hotels), and called at agent discretion via standard
MCP tool-calling whenever a Caller's question looks destination-related, not forced at
a fixed pipeline point the way Browser Tool's price-check is (that's a mandatory step
with a booking-flow consequence; this is a Q&A capability with none). It's wired into
the live Concierge session, not a standalone comparison build — nothing about Knowledge
Base access is an alternative to an already-decided primitive, so ADR-0002's
comparison-build pattern doesn't apply here.

Chunking strategy is left open: Managed KB's whole pitch is "fully managed, no infra to
configure," and it's unconfirmed whether it exposes a user-selectable chunking strategy
the way a classic KB does. Semantic chunking is the preference *if* that control exists;
this is an implementation detail for the build phase to confirm, not a locked decision.

## Consequences

Observability's traced-span list (ADR-0008) is amended to include this new Gateway
retrieve action — its "one session, every primitive, one trace" claim would otherwise
go silently stale the moment this ticket adds a Gateway action ADR-0008 didn't know
about. CONTEXT.md's Primitive glossary is *not* bumped to 11 — Knowledge Base is
recorded as a capability wired to the Gateway primitive, not a primitive of its own
(see CONTEXT.md's Knowledge Base entry).

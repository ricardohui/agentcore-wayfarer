# Knowledge Base is retrieved by a direct in-process bedrock-agent-runtime call, not a Gateway target

ADR-0009 put destination-guide retrieval behind a second AgentCore Gateway target, to
preserve Wayfarer's established pattern (ADR-0001 onward) of routing every Concierge
tool through Gateway — even though it explicitly noted AWS sanctions the direct
in-process `bedrock-agent-runtime` call as a standalone alternative. Revisiting that
call: the Gateway hop bought nothing here. Destination-guide retrieval is read-only and
ungated (REQ-KB-003) — it carries no Policy consequence, no candidate cache, no
multi-step tool sequence, none of the things Gateway earns its keep on for booking
(search/hold/approve, where Policy's Cedar gate and BookingGatewayPort's stateful
candidate cache genuinely need a mediating layer). What it cost, for that "no
consequence" tool, was a second `CfnGatewayTarget`, an IAM grant on the *Gateway's*
execution role rather than the Runtime's own, a Cedar policy
(`wayfarer_destination_guides_unrestricted`) that existed purely to undo the Policy
engine's default-deny, an MCP client + SigV4 transport built fresh per call, and a
CloudFormation dependency chain ordering this target's creation after the booking
target's own.

A single `RetrieveCommand` against `@aws-sdk/client-bedrock-agent-runtime` replaces all
of it: `BedrockKnowledgeBaseAdapter` (`src/concierge/adapter/`) takes an injected
`BedrockAgentRuntimeClient` and the Knowledge Base's id, the same constructor-injection
shape every other direct-SDK adapter in this codebase already follows
(`AgentCoreMemoryAdapter`, `CodeInterpreterBudgetAdapter`). The Retrieve API's response
shape (`retrievalResults[].content.text` / `.location.s3Location.uri` / `.score`) is
identical to what the Gateway connector was already handing back, so
`DestinationGuideExcerpt.parse` needed no change. The Runtime's own execution role now
holds `bedrock:Retrieve` on the Knowledge Base's ARN directly, rather than that grant
living on Gateway's shared execution role.

We accept losing the Cedar policy. `wayfarer_destination_guides_unrestricted` was an
unconditional permit — its only job was undoing the Policy engine's default-deny for
this one action — so no authorization semantics are lost, and REQ-KB-003's "read-only
and ungated" requirement is unchanged. If a future requirement needs to gate retrieval
(e.g. per-Caller content restrictions), that gate would need to be added as ordinary
usecase-level logic, since it no longer has a Policy engine sitting in front of it to
extend.

The Managed-KB-over-classic-KB choice from ADR-0009 (native connector support, no
vector-store infra) is untouched by this decision — `KnowledgeBaseConstruct` (the KB
itself, its S3 content bucket, and data source) is unchanged. Only the retrieval path
into it changed.

## Consequences

`KnowledgeBaseGatewayTargetConstruct` and `src/destination-guides/gateway-target-name.ts`
are deleted; `booking-gateway-construct.ts`'s `gatewayRole`/`bookingGatewayTarget`
fields, previously exposed so the KB target construct could attach to them, now serve
only `BookingGatewayConstruct`'s own internal wiring. ADR-0008's traced-span list is
amended a second time: the Knowledge Base retrieve action is no longer part of Gateway's
span — it is now a direct Bedrock call span outside the seven-primitive set. CONTEXT.md's
Knowledge Base entry is rewritten to describe a direct call rather than a Gateway
connector target; the Primitive glossary count stays at 10 either way — Knowledge Base
was never counted as an 11th primitive, and isn't now either.

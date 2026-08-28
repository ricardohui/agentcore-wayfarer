# AgentCore Runtime access to a Bedrock Knowledge Base (RAG)

Research date: 2026-08-28. All claims below are sourced from `docs.aws.amazon.com`,
`aws.amazon.com/blogs`, and AWS SDK reference sites, fetched live on this date.
AgentCore moves fast — re-verify against the release notes URL below before
relying on this for anything beyond a few months.

## Context / scope

Question: for an AgentCore Runtime-hosted, hand-written Node/TypeScript agent
(wrapped in `BedrockAgentCoreApp`, not classic Bedrock Agents, not necessarily
using Harness), what's the idiomatic way to do RAG against a Bedrock Knowledge
Base at runtime?

## Critical prerequisite fact: two different "Knowledge Base" products

AWS currently ships **two** distinct Bedrock Knowledge Base offerings, and the
Gateway story differs completely between them:

| | Customer-managed ("Knowledge Bases for Amazon Bedrock", GA since 2023) | Bedrock **Managed** Knowledge Base (new product, GA July 2026) |
|---|---|---|
| Vector store | You provision/choose (OpenSearch Serverless, Pinecone, etc.) | Fully managed by Bedrock, no infra |
| Agentic retrieval | Not supported | Supported |
| **AgentCore Gateway integration** | **Not supported** | **Supported (native connector target)** |

Source: comparison table in "Build a managed knowledge base",
https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html
(row: "AgentCore Gateway integration | Supported | Not supported").

This distinction gates the answer to Q1: **if Wayfarer's KB is the classic
customer-managed kind, there is no native Gateway target for it at all** —
you'd need a Lambda-fronted Gateway target (calling `Retrieve` yourself
inside the Lambda) or an in-process call. Only the new Managed Knowledge
Base product plugs into Gateway natively.

## Q1: Is there a documented Gateway target type for Knowledge Base retrieval?

**Yes, but only for the new Managed Knowledge Base product**, and it's a
first-class "connector" target type, distinct from the Lambda/OpenAPI/Smithy/
API-Gateway-stage/MCP-server/HTTP-runtime target types.

- "Amazon Bedrock AgentCore lets you add the following built-in connectors as
  targets in your gateway: Amazon Bedrock Managed Knowledge Bases, Web Search
  Tool." — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connectors.html
- Setup walkthrough ("Add a Connector target with Amazon Bedrock Managed
  Knowledge Bases"), including AgentCore CLI (`agentcore add gateway-target
  --type connector --connector bedrock-knowledge-bases --knowledge-base-id
  <KB_ID>`), Boto3, and parameter visibility controls
  (`parameterValues` / `parameterOverrides` to bind the KB ID and control
  what the agent can set, e.g. `$.retrievalQuery.text`) —
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-api-target-config.html
- AgentCore Python SDK has a dedicated helper,
  `GatewayClient.create_knowledge_base_target(gateway_identifier,
  knowledge_base_id, retrieval_configuration=..., parameter_overrides=...)`,
  which "creates a gateway target that exposes a Knowledge Base as an MCP
  Retrieve tool." —
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-python-sdk-reference.html
- AWS ML blog with a worked example showing an MCP client discovering and
  calling the KB tool without knowing the KB ID, and explicitly noting the
  standalone-API alternative (see Q2): "Build enterprise search for agents
  with Amazon Bedrock Managed Knowledge Base" —
  https://aws.amazon.com/blogs/machine-learning/build-enterprise-search-for-agents-with-amazon-bedrock-managed-knowledge-base/
- A second AWS ML blog (data mesh architecture) independently confirms the
  same fact in production-pattern language: "With the launch of Amazon
  Bedrock Managed Knowledge Base, knowledge bases are now available as a
  native pre-built target type in AgentCore Gateway... the native Managed KB
  target type reduces operational overhead by eliminating the Lambda
  function entirely." —
  https://aws.amazon.com/blogs/machine-learning/building-agentic-ai-applications-with-a-modern-data-mesh-strategy-on-aws/

For a **customer-managed/classic** Knowledge Base, Gateway remains "strictly
custom API/Lambda targets" — you'd write a Lambda that calls
`bedrock-agent-runtime:Retrieve` and front it with a normal Lambda target
(https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-api-target-config.html,
"Add a Lambda target" section), which is exactly the pattern Wayfarer already
uses for its mock flight/hotel tools per `docs/adr/0001-mock-gateway-backing.md`.

## Q2: Is calling `Retrieve`/`RetrieveAndGenerate` in-process (bypassing Gateway) a documented, recommended pattern?

Yes — AWS explicitly documents this as a supported, legitimate alternative,
not just a fallback:

> "You can also use Managed Knowledge Bases standalone by calling the
> retrieval APIs directly from your application if that better suits your
> use case."
— https://aws.amazon.com/blogs/machine-learning/build-enterprise-search-for-agents-with-amazon-bedrock-managed-knowledge-base/

For the classic customer-managed Knowledge Base, direct API calls have
always been the primary integration path (predates AgentCore entirely):
"Amazon Bedrock supports the following two APIs for RAG: `RetrieveAndGenerate`
... `Retrieve`..." —
https://docs.aws.amazon.com/prescriptive-guidance/latest/retrieval-augmented-generation-options/rag-fully-managed-bedrock.html

One API-selection nuance to watch for: `RetrieveAndGenerate` **cannot** be
used with the new Managed Knowledge Base product — "This API cannot be used
with managed knowledge bases. Use AgenticRetrieveStream or Retrieve with
managed knowledge bases." —
https://docs.aws.amazon.com/sdk-for-ruby/v3/api/Aws/BedrockAgentRuntime/Client.html
(same restriction appears across the SDK API references for
`bedrock-agent-runtime`). So: classic KB → `Retrieve` or `RetrieveAndGenerate`
both work; Managed KB called in-process → `Retrieve` or the newer
`AgenticRetrieveStream`, not `RetrieveAndGenerate`.

Practically: nothing in the docs prohibits or discourages calling
`bedrock-agent-runtime` directly from a Runtime handler and exposing it to
the model as an in-process tool (Converse API tool-use loop you write
yourself) — this is a normal, sanctioned pattern, just one that skips
Gateway's centralized auth/observability/tool-discovery layer.

## Q3: Does AgentCore Harness have a built-in "knowledge base" tool type?

**No.** The Harness tool-configuration schema (`HarnessToolConfiguration`)
is a closed union of exactly five member types:

```
HarnessToolConfiguration = Union[
    HarnessToolConfigurationRemoteMcp
  | HarnessToolConfigurationAgentCoreBrowser
  | HarnessToolConfigurationAgentCoreGateway
  | HarnessToolConfigurationInlineFunction
  | HarnessToolConfigurationAgentCoreCodeInterpreter
  | HarnessToolConfigurationUnknown
]
```

Sources:
- https://docs.aws.amazon.com/sdk-for-python/v1/reference/clients/bedrock-agentcore/unions/HarnessToolConfiguration/
- https://docs.aws.amazon.com/sdk-for-php/v3/api/api-bedrock-agentcore-2024-02-28.html (same union, describes members: `agentCoreBrowser`, `agentCoreCodeInterpreter`, `agentCoreGateway`, `inlineFunction`, `remoteMcp`)

There is no `knowledgeBase` (or similar) member. To give a Harness-run agent
RAG access you must go through `agentCoreGateway` pointing at either the
native Managed-Knowledge-Base connector target (Q1) or a Lambda target that
calls `Retrieve` (classic KB) — Harness itself has no first-class KB
primitive independent of Gateway. This is corroborated by the Harness
overview page's own tool description: "Agents can connect to tools through
AgentCore gateway, MCP servers, or use the built-in browser or code
interpreter." — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html
— knowledge bases aren't listed as a peer capability; they hang off Gateway.

## Q4: GA/preview status and doc dates

All of the following are confirmed via the live AgentCore release notes page
(https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html,
fetched 2026-08-28):

- **Amazon Bedrock Managed Knowledge Base**: GA in **July 2026** ("Amazon
  Bedrock Managed Knowledge Base is now Generally Available... Managed
  Knowledge Base provides a fully managed retrieval-augmented generation
  (RAG) pipeline that agents can query through the gateway").
- **AgentCore Gateway's native Managed-KB connector target**: shipped as
  part of the same July 2026 GA (the release note explicitly ties Gateway
  querying to the GA announcement; the connector-targets doc and the
  `create_knowledge_base_target` SDK method carry no preview marker as of
  this fetch).
- **AgentCore Harness**: GA in **July 2026** ("AgentCore Harness is now
  Generally Available... You can define an agent with CreateHarness and run
  it with InvokeHarness, with no orchestration code and no container to
  build"). It was in Public Preview starting **April 2026** ("AgentCore
  harness is now in Public Preview").
- **AgentCore Gateway itself** (the service, Lambda/OpenAPI/Smithy targets):
  GA since AgentCore's overall general availability in **October 2025** per
  the AWS News Blog update note: "Updated on October 13, 2025 – Amazon
  Bedrock AgentCore is now generally available." —
  https://aws.amazon.com/blogs/aws/introducing-amazon-bedrock-agentcore-securely-deploy-and-operate-ai-agents-at-any-scale/
- **Classic/customer-managed "Knowledge Bases for Amazon Bedrock"**: long-GA
  (predates AgentCore), but as noted in Q1 it has **no** native Gateway
  target — "AgentCore Gateway integration: Not supported" for
  customer-managed KBs per
  https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html.

Net: as of this research date, the entire native "Gateway fronts a Knowledge
Base" story is barely a month old (GA July 2026) and applies only to the new
Managed Knowledge Base product — treat it as new-and-thin (fewer
battle-tested examples in the wild) even though it's formally GA, not
preview.

## Cost of running Gateway + Knowledge Base

Two separate billing surfaces apply. AgentCore's own pricing page states
KB/Web-Search usage is "charged separately in accordance with the rates
defined or linked in the pricing table" —
https://aws.amazon.com/bedrock/agentcore/pricing/

**Gateway (exact figures, from that page's Pricing Table and worked example):**

| Meter | Price |
|---|---|
| API Invocations (`ListTools`, `InvokeTool`, `Ping`, etc.) | $0.005 per 1,000 invocations |
| Search API (semantic tool discovery) | $0.025 per 1,000 invocations |
| Tool Indexing | $0.02 per 100 tools indexed / month |
| VPC data egress | $0.006 per GB |

AWS's own worked example: a 200-tool gateway serving 50M interactions/month
(1 Search + 4 InvokeTool calls per interaction) costs **$2,250.04/month**
(SearchToolIndex $0.04 + Search API $1,250 + InvokeTool $1,000). At
learning-project volume (low thousands of `Retrieve` calls/month, one KB
tool), Gateway's own metering is a few cents to low single dollars — not the
cost driver.

**Bedrock Managed Knowledge Base** (the product with the native Gateway
target, Q1): billed for raw-data storage, retrieval API calls, and Agentic
Retrieval when used; the multimodal parser, managed embedding model, and
managed reranker are included at no extra cost by default (standard Bedrock
model pricing applies only if you swap in your own model for
embedding/reranking/orchestration). The AgentCore pricing table itself just
points onward — "Please see the Amazon Bedrock pricing page for details" —
for both the storage and query line items, and that page renders its
Knowledge Bases rate table via client-side tabs that didn't come through in
a static fetch, so **exact $/GB and $/query figures for Managed KB were not
confirmed** in this pass. Sources: https://aws.amazon.com/bedrock/agentcore/pricing/
(Pricing Table row "Bedrock Managed Knowledge Base"); https://aws.amazon.com/blogs/machine-learning/build-enterprise-search-for-agents-with-amazon-bedrock-managed-knowledge-base/
("Pricing" section); https://aws.amazon.com/bedrock/pricing/ (has a
"Knowledge Bases" tab, not statically extracted here — re-fetch or check the
AWS Pricing Calculator for hard numbers before budgeting).

**Classic customer-managed Knowledge Base** (relevant if Wayfarer stays on
this type, since it has no native Gateway target per Q1): the dominant cost
is almost always the **backing vector store**, not Bedrock itself. One AWS
cost worksheet for an 8,000-query/day workload shows Titan embeddings at
~$9/month against Amazon OpenSearch Service Serverless's *billable minimum*
(4 OCUs) alone at ~$691/month —
https://docs.aws.amazon.com/solutions/latest/generative-ai-application-builder-on-aws/cost.html
("Costs for adding a knowledge base"). "Amazon Bedrock does not incur cost
for using the knowledge base feature itself" beyond the embedding-model
token cost per query — same source. Cheaper backing stores (e.g. S3 Vectors)
avoid OpenSearch Serverless's provisioned minimum if cost matters for a
learning project.

**Bottom line:** at Wayfarer's likely usage scale, Gateway's per-call
metering is near-free; the real cost lever is which KB backend you choose —
a classic KB on OpenSearch Serverless carries a real monthly floor
(~$690+), while Managed KB is marketed as usage-based with no stated
minimum but its exact rate wasn't confirmed here.

## Recommendation for Wayfarer

**(a) New Gateway tool**, backed by a **Bedrock Managed Knowledge Base**
(not a customer-managed/classic KB). This keeps RAG consistent with
Wayfarer's existing pattern of routing every tool through Gateway (ADR 0001)
and uses the native connector-target type (Q1) instead of a hand-rolled
Lambda — it's the only KB flavor that plugs into Gateway natively, it comes
with embedding/reranking/parsing included at no extra cost, and it avoids
the ~$690/month OpenSearch Serverless floor that a classic KB would carry
(Cost section above). Reserve the direct in-process `bedrock-agent-runtime`
call (Q2) for a deliberate "raw SDK vs. Gateway-mediated" comparison
exercise, not as the primary path.

## Status: not yet decided

No decision has been confirmed. This doc's job is to answer Q1-Q4 as input
to a still-open grilling round with the user on the Wayfarer wayfinder map
(issue #1) — the "Recommendation" section above is this research pass's
suggestion, not something the user has agreed to. Do not treat it as
settled, open a ticket off it, or write an ADR from it until the user has
actually chosen a path.

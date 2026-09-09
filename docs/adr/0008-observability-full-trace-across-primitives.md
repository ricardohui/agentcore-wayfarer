# Observability traces every live-Concierge primitive into one session in the GenAI Observability dashboard

Wayfarer's Concierge touches seven other already-decided primitives per session
(Runtime, Gateway, Memory, Identity, Code Interpreter, Browser Tool, Policy) —
Harness is excluded, since ADR-0002 already scoped it to a standalone
comparison build never wired into the live Concierge. We considered tracing
only a subset (e.g. just Gateway tool calls, since those are the visible
"actions") but rejected it: the teaching point of this ticket is one session,
every primitive, one trace — a partial trace would leave a visible gap in the
story and wouldn't demonstrate that AgentCore's tracing is genuinely
cross-cutting.

Every one of those seven primitives gets its own span: Runtime (session),
Gateway (search-flights/hold-flight/search-hotels/hold-hotel/approve-hold),
Memory (get_last_k_turns, create_event, the two Memory Strategies), Identity
(Cognito inbound auth + OAuth2 consent handshake), Code Interpreter
(executeCode running-total updates), Browser Tool (price-check), Policy
(Cedar approval gate). Knowledge Base retrieval (ADR-0010) is a direct
in-process `bedrock-agent-runtime` call, not a Gateway action, and gets its
own span outside this seven-primitive set. This span set is a superset of what Evaluations
(ADR from issue #10) already requires from OTEL — input, output, tool calls,
latency per step — so Observability's scope also satisfies Evaluations
rather than being designed independently of it.

Instrumentation goes through the ADOT SDK (or the AWS Lambda Layer for OTel)
— the ADOT Collector itself is not supported for AgentCore agent
observability. The primary surface for reviewing a session is AgentCore's
GenAI Observability dashboard, not raw CloudWatch Logs/X-Ray queries — those
remain the underlying mechanism, not a second deliverable. Sampling is 100%:
single test user, low volume, so a reduced-sampling knob would demonstrate a
feature nobody in this scenario would use.

Span attributes are sanitized narrowly, not broadly: only OAuth token/secret
values from Identity's consent-flow spans are redacted (kept as flow state,
e.g. `pending`/`approved`), because those are the one genuine credential in
this trace. Code Interpreter's budget figures and Memory's preference facts
stay visible — they aren't credentials, and they're the substance a reviewer
needs to see to judge whether the trace is "good."

The learning task is: instrument the Concierge with the spans above, run one
live end-to-end session (the standard 3-city search-then-hold-with-approval
scenario), and inspect/annotate the resulting trace in the GenAI Observability
dashboard. CloudWatch alarms (error rate, p99 latency, token usage) are
explicitly out of scope — they're an operational concern for a running
production service, not part of verifying tracing is wired correctly.

## Revision (issue #24, first live implementation attempt)

"Instrumentation goes through the ADOT SDK (or the AWS Lambda Layer for
OTel)" above assumed one of those two off-the-shelf paths would work. Neither
did. AgentCore does not auto-emit spans for a Runtime-hosted agent (confirmed
empirically while implementing Evaluations, issue #23 — see ADR-0007's own
Revision) — an agent process must be instrumented itself. The Node ADOT
distro (`@aws/aws-distro-opentelemetry-node-autoinstrumentation`) turned out
to expose no importable API at all: its `package.json` `exports` map only
publishes a `./register` subpath meant for the `opentelemetry-instrument`
CLI wrapper, which works by patching Node's `require()` at runtime — AWS's
own docs warn this "is only compatible with CommonJS module output" and
"silently fails" under ESM. The Concierge's deployed bundle is ESM
(`bedrock-agentcore` is ESM-only), and ESM's own module graph never routes
through `require()` for such patching to intercept, regardless of whether
the entry point itself is CommonJS.

What actually shipped is a hand-rolled manual OpenTelemetry pipeline
(`src/concierge/observability/tracing.ts`), built from the same public
`@opentelemetry/*` packages the ADOT distro itself depends on, since none of
them individually have the ESM problem — only the distro's own
`require()`-patching auto-instrumentation entry point does:

- `BasicTracerProvider` (`@opentelemetry/sdk-trace-base`) with
  `AWSXRayIdGenerator` (`@opentelemetry/id-generator-aws-xray`) for
  X-Ray-compatible trace IDs, and `AsyncHooksContextManager`
  (`@opentelemetry/context-async-hooks`) so a span started in one async
  function is still the active parent when a later `await`ed call starts its
  own child span — this is what gives one session's spans the correct
  parent/child nesting under one `InvokeAgent` root, confirmed against a real
  trace (`aws logs` on the `aws/spans` log group) showing eight children —
  `Identity.InboundAuth`, `get_last_k_turns`, two `chat <model>` rounds,
  `execute_tool search-flights`, `RetrieveMemoryRecords`, `create_event`, plus
  further holds — all correctly parented under one `InvokeAgent` span, and
  none of them siblings/roots.
- A custom `SpanExporter` that serializes each batch via
  `ProtobufTraceSerializer` (`@opentelemetry/otlp-transformer` — the same
  serializer the standard OTLP exporters use internally) and POSTs the bytes,
  SigV4-signed with `@smithy/signature-v4` (the same signing primitives
  `sigv4-fetch.ts` already uses for Gateway calls, not reused directly since
  it only forwards a `string` body and this needs a binary one), to
  `https://xray.<region>.amazonaws.com/v1/traces` — the CloudWatch OTLP
  traces endpoint AWS's own OpenTelemetry Collector configuration examples
  use, requiring `xray:PutTraceSegments`/`PutSpans`/`PutSpansForIndexing`/
  `PutTelemetryRecords` on the Runtime's role (not ARN-scoped — matches the
  `AWSXRayDaemonWriteAccess` managed policy's own `"Resource": ["*"]`).
- `withSpan()`, the one seam every instrumented adapter method uses — starts
  a span as a child of whatever's active, sets attributes, runs the wrapped
  call, records success/failure, always ends the span.

Span naming and attributes follow AgentCore Evaluations' own "Generic
framework support" conventions (`gen_ai.operation.name`,
`gen_ai.input.messages`/`gen_ai.output.messages` on `chat <model>` spans,
`gen_ai.tool.name`/`gen_ai.tool.call.arguments`/`gen_ai.tool.call.result` on
`execute_tool <name>` spans) rather than inventing a bespoke shape — this is
also what ADR-0007 depends on for the LLM-judge evaluator's `{context}`
placeholder to render something coherent.

`withSpan()` lives in a new `src/concierge/observability/` module, not under
`infra/` — every instrumented method sits in `adapter/`, and this repo's
Clean Architecture dependency rule (`infra → adapter → usecase → domain`,
dependencies point inward, nothing depends on `infra`) means an
`adapter/`-owned span helper can't live in `infra/` without adapter
importing infra backwards. Tracing is treated the same way a cross-cutting
logger would be — directly available to any layer, not modeled as a
usecase-level port, since it carries no business decision and needs no
business-level test double.

This ADR's original span list is otherwise unchanged and now confirmed
working end to end: Runtime (`InvokeAgent`), Gateway (all 5 booking actions
via `execute_tool`, folding Policy's ALLOW/DENY into the same span rather
than a separate one — Policy has no AWS call of its own on this side of the
wire), Memory (`get_last_k_turns`, `create_event`, `RetrieveMemoryRecords`
for both Strategies), Code Interpreter (`executeCode`, budget figures
unredacted), Browser Tool (`price-check`), and Identity's inbound check
(`Identity.InboundAuth`). Knowledge Base's `Retrieve` span (ADR-0010, outside
the seven-primitive set) is confirmed too. Identity's delegated **consent
handshake** span (`Identity.ConsentHandshake`, with `redactTokenValue()`
scrubbing the workload-identity and access tokens) is implemented and code-
reviewed but not yet exercised by a completed live OAuth2 authorization-code
flow — that needs an out-of-band browser visit to the mock authorization
server's consent screen, deferred as a follow-up manual check rather than
blocking this ticket's (or #23's) real need.

## Revision (issue #23, split-telemetry event-record pipeline)

This account's Runtime delivers telemetry in AgentCore's "split" mode (payload content
off the span, in a correlated CloudWatch Logs event record — see ADR-0007's Revision 3
for the full diagnosis and why the "unified" mode's simpler span-only shape couldn't be
reached from a hand-rolled, non-ADOT tracer). `tracing.ts` gained a second delivery path
alongside the Traces one this ADR already describes: `emitEventRecord()`, writing one
`PutLogEventsCommand` per content-bearing span to the Runtime's own log group's
`otel-rt-logs` stream, discovered at runtime by name rather than referenced by ID (a
circular CloudFormation dependency otherwise). New IAM on the Runtime's role:
`logs:DescribeLogGroups`, `logs:CreateLogStream`, `logs:PutLogEvents`. This is purely an
Evaluations-consumption concern — no new primitive spans, no change to this ADR's
traced-span list.

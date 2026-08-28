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
Gateway (search-flights/hold-flight/search-hotels/hold-hotel/approve-hold,
plus the Knowledge Base retrieve action added by ADR-0009), Memory
(get_last_k_turns, create_event, the two Memory Strategies), Identity
(Cognito inbound auth + OAuth2 consent handshake), Code Interpreter
(executeCode running-total updates), Browser Tool (price-check), Policy
(Cedar approval gate). This span set is a superset of what Evaluations
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

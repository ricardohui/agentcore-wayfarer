# Evaluations gates itinerary quality with a deterministic budget check AND'd with a holistic LLM judge

Evaluations' rubric beat (issue #10) needs to judge whether a Wayfarer planning
session produced a good itinerary — relevant, budget-respecting, complete. Budget-
respecting is already an exact number: Code Interpreter's Running total and Budget
breakdown (issue #7) settle it without ambiguity. Folding it into an LLM-as-judge
rubric alongside the fuzzier criteria would launder a deterministic fact through a
model call for no gain. We split the pass bar into two AgentCore custom evaluators
instead of one: a TOOL_CALL-level deterministic gate reading the Code Interpreter
tool-call output (`Running total <= budget`), AND'd with a SESSION-level holistic
LLM-as-judge covering relevant (holds match the Caller's stated destinations/dates/
constraints) and complete (all 3 cities end the session with both a flight hold and a
hotel hold). A run passes only if both gates pass.

Both gates are registered through the Evaluations service (`create-evaluator`)
rather than splitting the deterministic half into ad hoc test code outside
AgentCore — this ticket's learning task is Evaluations itself, so the budget gate
stays inside the primitive being taught even though it needs no LLM.

Evaluation mode is on-demand, not online: Wayfarer has no production traffic to
sample continuously. The test dataset is 3 live-generated transcripts (happy path,
over-budget, incomplete) produced by actually running the composed 8-primitive
Wayfarer stack with steered inputs, not hand-authored fixture JSON — the same
reasoning as ADR-0005's preference for exercising the real system over synthetic
stand-ins. No blocking edge to Observability (issue #11): baseline OTEL traces are
emitted automatically per-service regardless of what Observability's ticket decides
to surface, so Evaluations can read them now.

## Consequences

The learning task is: CDK-provision the two custom evaluators, run the live scenario
3x to generate the on-demand test dataset, trigger the on-demand evaluation run, and
read pass/fail plus scores back from CloudWatch. This is the same provision-exercise-
observe grain as the other 8 resolved primitives. Evaluations depends on Code
Interpreter's tool-call output shape (issue #7) for its deterministic gate and on the
full composed scenario (all 8 other primitives) for its live-generated dataset, but
does not depend on Observability's ticket being resolved first.

## Revision (issue #23, first live verification attempt)

The "does not depend on Observability's ticket being resolved first" claim above was
wrong. It assumed AgentCore emits baseline OTEL trace spans automatically per-service,
independent of whatever Observability's ticket (issue #24) later decides to
instrument. Live verification disproved that: CloudWatch Transaction Search is active
for this account (`aws xray get-trace-segment-destination` → `ACTIVE`), but
`aws xray get-trace-summaries` shows zero traces recorded in the last 24 hours, and the
shared `aws/spans` log group is empty. AgentCore Runtime does not spontaneously trace
Gateway/Code Interpreter/model calls on its own — an agent process must be instrumented
with the ADOT SDK (or, outside AgentCore Runtime, the AWS Lambda Layer for
OpenTelemetry) before any span exists for Evaluations' `Evaluate` API to read
(`evaluationInput.sessionSpans`), confirmed against AWS's own Evaluations docs
("Telemetry setup and delivery": *"Instrumenting your agent is one part of producing
telemetry... your agent must also have observability enabled"*).

Attempting the smallest possible fix inside issue #23 surfaced a second, sharper
problem: ADOT's Node.js auto-instrumentation (`@aws/aws-distro-opentelemetry-node-
autoinstrumentation`, invoked via the `opentelemetry-instrument` entry-point prefix)
works by patching Node's `require()` at runtime, and AWS's own docs warn this "is only
compatible with CommonJS module output... [ESM] instrumentation silently fails and no
traces are emitted." The Concierge's deployed bundle is ESM (`build-handler.mjs`'s
`format: "esm"`) because its `bedrock-agentcore` dependency ships ESM-only
(`infra/handler.ts`'s own comment) — auto-instrumentation cannot work here without
either restructuring the bundle to CommonJS (blocked by that same ESM-only dependency)
or hand-rolling manual OTEL spans with AgentCore's exact `gen_ai.*` semantic-convention
attributes, which is Observability's (issue #24) actual scope, not a small add-on to
Evaluations.

Evaluations' two evaluators (`wayfarer_budget_gate`, `wayfarer_itinerary_quality`) are
deployed and correct — `evaluator-config`/CDK provisioning needed no revision. What's
revised is the dependency claim: **Evaluations' on-demand `Evaluate` step is now
recorded as blocked on Observability (issue #24)** being resolved first, reversing this
ADR's original ordering. The evaluators, the Lambda's parsing/scoring logic (unit
tested), and the transcript-generating probe scripts are done; triggering the on-demand
run and reading real CloudWatch pass/fail results is deferred until #24 lands real
instrumentation.

## Revision 2 (issue #23, after #24 shipped real instrumentation)

With #24's spans landing in `aws/spans`, the on-demand `Evaluate` API run itself
surfaced two more AgentCore-internal requirements neither this ADR nor #24's own
research anticipated, both specific to the SESSION LLM-as-a-judge evaluator (the
TOOL_CALL code-based gate never had either problem — its Lambda parses whatever JSON it's
handed, so it's indifferent to any of this):

1. **Scope allow-list**: the judge rejected our spans outright
   (`SessionValidationException: ... no spans with supported scope`) until the tracer's
   own name (`scope.name` on every span) was one of a fixed list of known agent-framework
   instrumentation libraries (Strands, LangChain, OpenAI Agents, LlamaIndex, Google ADK,
   Claude Agent SDK, Vercel AI). A hand-rolled, framework-agnostic OTEL setup — which is
   what ADR-0008's Revision describes building, out of necessity — isn't itself an
   accepted scope. Fixed by labeling the tracer `opentelemetry.instrumentation.langchain`
   (`INSTRUMENTATION_SCOPE_NAME`, `tracing.ts`) — a compatibility label, not a claim this
   Concierge runs LangChain, chosen because our span shape
   (`gen_ai.tool.call.arguments`/`gen_ai.tool.call.result`,
   `gen_ai.input.messages`/`gen_ai.output.messages`) already matches what that scope's own
   spans carry, per AWS's own LangGraph telemetry documentation.
2. **`traceloop.span.kind`**: past the scope check, the judge then rejected sessions with
   `no spans to evaluate... have model/tool/agent invocation details for the provided
   scope` until every span carried a `traceloop.span.kind` attribute (`llm` for `chat`
   spans, `tool` for `execute_tool` spans, `workflow` for the root `InvokeAgent` span) —
   a Traceloop-namespaced convention the LangChain scope reuses, not a stated part of any
   OTEL or Bedrock semantic-convention document this ADR or ADR-0008 found. Fixed in
   `withSpan()`'s one seam (`traceloopSpanKind()`), derived from `gen_ai.operation.name`
   rather than threaded through every call site.

Both fixes are confirmed live: a real `Evaluate` call against a fresh single-turn session
returned a correct, well-reasoned `Fail` judgment ("the session contains no flight or
hotel holds... fails the completeness requirement") — the judge genuinely reads and
reasons over the span content once it accepts the input.

**The deterministic gate is fully verified against the real 3-transcript dataset,
end to end**, via real `Evaluate` calls:

| Transcript | Real Running total | Budget gate result | Matches expectation |
|---|---|---|---|
| happy | $3,694.91 | PASS | yes |
| over-budget | $4,374.08 | FAIL | yes |
| incomplete | $939.60 | PASS (not the criterion this transcript tests) | n/a |

(The "happy" and "over-budget" labels above are assigned by each session's *real* total,
not by which steering — cheapest vs. most-expensive — originally produced it: a
mid-conversation `ModelError` on both live runs, from the model exceeding
`MAX_TOOL_USE_ROUNDS`, meant a retried turn's holds landed on top of an earlier turn's
already-successful ones that never reached the model's own conversational memory
[`recordTurn` is skipped on `ModelError`] — both sessions ended up with some cities
double-held, and by coincidence the "cheapest everywhere" session's real total came out
higher than the "most expensive everywhere" session's. The deterministic gate only cares
about the real number, so the two sessions were assigned to whichever role their real
total actually demonstrates — REQ-EVAL-004's "live-generated, not hand-authored" bar is
still met; only the session→label mapping is empirical rather than intentional.)

**The LLM judge was not yet fully verified against the real dataset** as of this
revision — since resolved; see Revision 3 below. Past both fixes above, the `Evaluate`
call for `wayfarer_itinerary_quality` against any of the 3 multi-turn transcripts failed
with `LogEventMissingException: Session span data is incomplete. Span with ID: <id> and
name: InvokeAgent is missing a corresponding log event` — a third, undocumented-until-
diagnosed requirement.

## Revision 3 (issue #23, the actual fix + full live verification)

AgentCore Evaluations reads a session's telemetry in one of two **delivery modes**
(`docs.aws.amazon.com/bedrock-agentcore/.../supported-frameworks-telemetry.html`,
found only after the `LogEventMissingException` above sent us looking for what
"telemetry delivery mode" even meant):

- **Unified telemetry** (AWS's recommended default for new agents): model/tool payload
  attributes stay on the span itself — exactly what this Concierge's spans already
  carried (`gen_ai.task.input`/`output`, `gen_ai.tool.call.arguments`/`result`).
- **Split telemetry** (this account's default — Runtimes created before unified
  telemetry's regional rollout keep it unless opted in, and see below on why opting in
  didn't work here): those same payload attributes are pulled **off** the span and
  delivered as a separate, correlated **event record** (same `traceId`/`spanId`, content
  under `body.input`/`body.output`) to the `otel-rt-logs` log stream in the Runtime's
  own CloudWatch log group. Without a matching event record, the judge can't reconstruct
  that span's content — hence `LogEventMissingException`.

**First attempted the easy path**: `UNIFIED_TRACES_DESTINATION_ENABLED=true` on the
Runtime, plus the `logs:PutResourcePolicy` grant AWS's docs say it needs. Deployed,
tested live — spans kept landing in the shared `aws/spans` log group exactly as before;
no `spans` stream ever appeared in the Runtime's own log group. AWS's own docs explain
why: *"The agent uses ADOT version 0.18.0 or later... earlier versions ignore the span
destination configuration."* The platform gates unified-mode routing on recognizing the
sender as a real ADOT SDK build — a hand-rolled tracer, no matter how spec-compliant its
spans are, isn't one. This is the same ESM wall from ADR-0008's Revision, from a
different angle: there's no route to unified telemetry without the actual ADOT package,
and that package can't run against this bundle.

**So split telemetry's event-record pipeline is what actually ships** — the second
OTEL-adjacent export path this ADR's Revision 2 anticipated needing, now built
(`src/concierge/observability/tracing.ts`):

- `withSpan()` wraps every span's own real `Span` in a `Proxy` that mirrors every
  `setAttribute()` call (both its own initial ones and any a caller makes later, e.g.
  `handler.ts` setting `gen_ai.task.output` once a reply is known) into a plain
  accumulator object — the complete, final attribute set is only known once the wrapped
  call finishes, not when the span starts.
- Once finished, `buildEventRecordBody()` repackages that accumulated content into the
  documented `body.input.messages`/`body.output.messages` parts-format shape, for the
  three span kinds that carry content (`invoke_agent`, `chat`, `execute_tool` — Memory's
  spans carry none, so get no event record).
- `emitEventRecord()` writes it as one `PutLogEventsCommand` to `otel-rt-logs`, in a log
  group **discovered at runtime** rather than passed in: the Runtime's generated
  `agentRuntimeId` (and therefore its log group's full name) doesn't exist until the
  Runtime resource is created, and referencing it from a policy or environment variable
  *on that same Runtime resource* is a circular CloudFormation dependency
  (`Runtime -> Role/EnvVars -> Runtime`) — so `discoverLogGroupName()` prefix-searches
  CloudWatch once per process using the fixed, known Runtime name instead
  (`CONCIERGE_RUNTIME_NAME`, extracted to its own module so both the CDK stack and
  `tracing.ts` share one source of truth). New IAM: `logs:DescribeLogGroups` (account-
  wide by nature, not resource-scoped), `logs:CreateLogStream`/`logs:PutLogEvents`
  (wildcard-scoped to `/aws/bedrock-agentcore/runtimes/*:log-stream:otel-rt-logs`, same
  reasoning as every other wildcard grant in this stack: the exact runtime ID isn't
  knowable at synth time and only one Runtime exists here).
- Delivery is best-effort and silent on failure — matching the Traces exporter's own
  treatment of a failed export (no registered diag logger to surface through either) —
  since every adapter's own acceptance test imports `infra/handler.ts` directly, running
  `startTracing()` for real against test credentials with no CloudWatch Logs
  network-boundary mock; logging failures here would be test noise, not signal.

**A second, independent bug surfaced once event records existed but the judge still
failed** on the exact same span every time (not a propagation-timing issue - confirmed
by retrying after a delay with an identical result). The event record for that span
existed and was well-formed, but its `body.output` key was simply absent:
`handler.ts`'s `gen_ai.task.output` attribute was only ever set on the successful
reply path — the three "safe fallback message" early returns (auth rejected, malformed
Caller message, `ModelError`) each returned their fallback string directly, bypassing
the `span.setAttribute(...)` call entirely. Every one of the final 3 transcripts has at
least one `ModelError` turn in it (the model exceeding `MAX_TOOL_USE_ROUNDS` mid-
conversation, then retried) - and one incomplete event record was enough to fail
`Evaluate` for the *entire* session, not just skip that one span. Fixed by restructuring
`handler.ts`'s callback into a single exit point: an inner `respond()` function returns
the reply from any path, and `gen_ai.task.output` is set exactly once, unconditionally,
before returning.

**Full live verification, after both fixes, against the final 3-transcript dataset**
(regenerated once more so every transcript's spans postdate both fixes — this dataset's
real Code Interpreter totals also differ from Revision 2's, since the mock catalog
randomizes prices per run; `WAYFARER_SCENARIO_BUDGET_USD` was recalibrated a final time
to $3,600, between this specific dataset's real happy ($3,594.10) and over-budget
($4,061.83) totals):

| Transcript | Budget gate | Judge | Both match expectation |
|---|---|---|---|
| happy | PASS ($3,594.10 ≤ $3,600) | Pass — relevant + complete | yes |
| over-budget | FAIL ($4,061.83 > $3,600) | Pass — relevant + complete | yes |
| incomplete | PASS (not the criterion this transcript tests) | Fail — incomplete (only Tokyo held) | yes |

All 6 of issue #23's acceptance-criteria checkboxes are met. The "happy"/"over-budget"
session-to-label mapping is still assigned by each session's real total rather than by
which steering produced it, per Revision 2's explanation — unchanged by this revision.

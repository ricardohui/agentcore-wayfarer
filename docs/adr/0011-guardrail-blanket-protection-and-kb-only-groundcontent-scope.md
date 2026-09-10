# Guardrail: blanket protection scoped narrowly, guardContent limited to Knowledge Base

Issue #26 (part of #25) added a Bedrock Guardrail to the Concierge's own Converse calls.
Three decisions here are hard to reverse, non-obvious without the reasoning behind them,
and genuine trade-offs — worth recording before they're lost.

## guardContent scope: Knowledge Base only, not Browser Tool

The original design (from the grilling session that produced issue #25's spec) assumed
`guardContent` wrapping would apply to both tool results carrying real external content:
Knowledge Base retrieval and Browser Tool's price-check. Cross-referencing that
assumption against the actual code — `booking-tool-executor.ts`'s `serializeHold()` —
showed it was wrong. `PriceCheckPort.checkPrice()`'s result (a `LocalPrice`) is read
automatically before every `hold-flight`/`hold-hotel` call and folded straight into that
tool's own JSON payload as a strictly-parsed `{amount, currency}` pair; it is never
returned to the model as its own tool result. There is nothing free-text or
independently addressable to wrap. Confirmed further: the model-facing tool catalog
(`BedrockConverseModelClient`'s `TOOL_CONFIG`) has no price-check tool at all — it's
purely an internal side effect of holding a candidate.

`retrieve-destination-guide` is the only tool whose result is both (a) its own
independently-addressable `toolResult` block and (b) genuinely external, retrieved free
text the model could be steered by. That makes it the only tool result the Guardrail's
contextual grounding policy has anything meaningful to check, and the only one worth the
`guardContent` wrapping cost.

Implementation-wise, `guardContent` isn't even a variant of `ToolResultContentBlock` in
the Bedrock SDK — confirmed against `@aws-sdk/client-bedrock-runtime`'s own types, and
matching the Converse API's documented behavior that `messages[].content[].toolResult`
is never guardrail-evaluated by any filter, `guardContent` or not. So wrapping couldn't
mean nesting `guardContent` inside the `toolResult` block even if we wanted to for a
second tool — it means adding sibling `guardContent` content blocks alongside the
ordinary `toolResult` block in the same tool-result message. A contextual grounding
check needs both halves of a source/query pair to run at all (AWS's own
contextual-grounding-check docs), so `toToolResultContentBlocks()`
(`src/concierge/adapter/bedrock-converse-model-client.ts`) emits two: the retrieved
excerpt text tagged `grounding_source`, and the model's own `query` tool-call argument
tagged `query`. Both branch on `call.name === "retrieve-destination-guide"`, and both
are skipped (leaving only the plain `toolResult` block) whenever there's nothing real to
ground — an errored retrieval, zero excerpts, or an unparseable query — since grounding
an answer against an error message or an empty source is meaningless. Every other tool
name (`search-flights`, `search-hotels`, `hold-flight`, `hold-hotel`, `approve-hold`,
`write-calendar-event`) always returns only the plain `toolResult` block, unchanged from
before this issue.

This also settles a real risk that was worth checking before committing to
`guardContent` anywhere: does adding a `guardContent` block anywhere in a Converse call's
messages turn off blanket content-filter/topic/PII evaluation of the rest of that call?
Per AWS's own docs, the answer is policy-specific — contextual grounding checks are
scoped strictly to `guardContent`-tagged blocks (by design, since grounding needs an
explicit source/query pair), but content filters, denied topics, and the sensitive-
information policy continue to evaluate every ordinary `text` block in the same request
regardless of any `guardContent` blocks present elsewhere. Blanket protection on every
Caller turn (issue #26's other core requirement) is unaffected by this KB-only
`guardContent` usage.

## Three live findings from deploying and probing the real Runtime

The first deploy attempt (`CreateGuardrail`) failed with two real API errors, both fixed
before the second attempt succeeded:

- `PROMPT_ATTACK`'s `outputStrength` must be `NONE` — Bedrock rejects any other value
  ("PROMPT ATTACK content filter strength for response must be NONE"). This makes sense
  once stated: a prompt attack is something a Caller does *to* the model, not a category
  the model's own response could itself fall into, so there's no "response" side to rate
  a strength for. `MISCONDUCT` (the guardrail's other `HIGH`-strength filter) has no such
  restriction and stays `HIGH`/`HIGH`.
- Denied-topic `definition`s are capped at 200 characters, and the original draft's
  "not to be confused with..." exclusion clauses (added to keep travel-relevant
  health/safety and legal-fact questions out of scope) both blew past that limit and
  violated AWS's own stated best practice against negative/exception-carrying
  definitions. Rewritten to scope each topic to a *personal* matter instead (a personal
  health condition, a personal legal dispute, personal investment choices) — a positive,
  narrow definition that keeps the same carve-outs (a destination's general water-safety
  or visa-rule facts aren't a *personal* diagnosis or legal dispute) without needing
  exclusion language at all.

Deploy succeeded on the second attempt, but the first real Converse call against the
live Runtime still failed: `AccessDeniedException` — `bedrock:ApplyGuardrail` on the
guardrail's own ARN, distinct from `bedrock:InvokeModel` on the foundation model. A
Converse call carrying `guardrailConfig` needs both grants on the caller's identity;
only the model grant existed. Fixed by adding a third `PolicyStatement` (`ApplyGuardrail`
scoped to `this.guardrail.guardrail.attrGuardrailArn`) to `ConciergeStack`. After this
fix, all three of issue #26's live probes passed against the deployed Runtime, confirmed
via CloudWatch: an off-topic ask ("Can you help me with my math homework?") and a
credit-card-shaped number both returned the guardrail's exact `blockedInputMessaging`
text; a real destination question ("What's the visa situation for visiting Tokyo?")
returned a correctly KB-grounded answer with no errors, exercising the `grounding_source`
+ `query` `guardContent` pair end-to-end for the first time against the real API.

## PII carve-out: exactly 4 entity types, not "ALL"

The sensitive-information policy `BLOCK`s only credit/debit card number, US Social
Security Number, US passport number, and driver's license/ID number — every other PII
entity type Bedrock supports (name, address, phone, email, and the rest) is left
untouched. This is deliberate, not an oversight: Memory's whole personalization feature
(REQ-MEMORY-002 — home airport, dietary/seat preferences, semantic preferences extracted
across sessions) depends on that content flowing through the model unfiltered. A blanket
`ALL`-entity PII policy would silently break Memory's recall on the very first name or
address the Caller mentions, with no obvious error — the reply would just quietly stop
referencing what the Caller told it. The four entities kept are ones Wayfarer has no
legitimate reason to ever need in a travel-planning conversation, and each maps directly
to a concrete accidental-paste scenario (issue #25's user stories 6 and 7).

## Denied topics and content-filter strengths

Four denied topics — financial/investment advice, medical/health advice, legal advice,
and general non-travel Q&A — are each scoped to a *personal* matter (see "Two live-deploy
corrections" above for why: a positive, under-200-character definition, not an
exclusion clause). Scoping to "personal" is what keeps the travel-relevant adjacent
questions answerable without naming them as exceptions: a trip's budget/booking prices
aren't personalized investment advice, a destination's general water-safety or
altitude-sickness facts aren't a diagnosis for a personal condition, and a destination's
visa rules aren't strategy for a personal legal dispute. This is the concrete
implementation of issue #25's user story 5 — without some form of this narrowing,
Bedrock's topic classifier has a well-documented tendency to over-block adjacent
legitimate content once a topic name and examples are provided.

Content filter strengths split `HIGH` (`PROMPT_ATTACK`, `MISCONDUCT`) from `MEDIUM`
(`HATE`, `INSULTS`, `SEXUAL`, `VIOLENCE`) rather than uniform `HIGH` everywhere.
Prompt-attack and misconduct detection are the two categories most directly tied to this
Concierge's own security posture (someone trying to jailbreak it into off-role behavior,
or use it for something harmful) — worth over-blocking for. The general harmful-content
categories are set to the more balanced `MEDIUM` tier so ordinary trip-planning language
(discussing a destination's history, nightlife, or safety concerns) isn't caught by an
overly aggressive filter tuned for a different kind of application.

## Consequences

`infra/cdk/lib/guardrail-construct.ts` is a new construct, built directly against
`CfnGuardrail`/`CfnGuardrailVersion` (no L2 exists in the installed `aws-cdk-lib`
version). `ConciergeStack` wires its pinned id/version into the Runtime as
`GUARDRAIL_ID`/`GUARDRAIL_VERSION` environment variables, and adds three IAM statements
to the Runtime's own execution role only: `bedrock:ApplyGuardrail` scoped to the
guardrail's ARN (required for any Converse call that carries `guardrailConfig` —
separate from and in addition to the existing `bedrock:InvokeModel` grant on the
foundation model), plus an explicit `Deny` on
`bedrock:InvokeModel`/`InvokeModelWithResponseStream` keyed on `bedrock:GuardrailIdentifier`
`StringNotEquals` the guardrail's `arn:...:guardrail/<id>:<version>` — AWS's own
documented pattern for this condition key, confirmed against
`docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions-id.html`.
`BedrockConverseModelClient` takes the guardrail id/version as constructor parameters
and attaches `guardrailConfig` (with `trace: "disabled"`) to every `ConverseCommand`
call. All three of issue #26's live probes (off-topic ask, PII-carrying message,
Knowledge-Base-grounded destination question) passed against the deployed Runtime,
confirmed via CloudWatch. If a future tool ever exposes genuinely external free text as
its own tool result (unlike today's Browser Tool), it would need the same `guardContent`
treatment `retrieve-destination-guide` gets here — this ADR's KB-only scoping is a
statement about today's tool shapes, not a permanent architectural limit.

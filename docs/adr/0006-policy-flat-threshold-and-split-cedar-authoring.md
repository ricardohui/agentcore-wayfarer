# Policy gates hold-flight/hold-hotel above a flat Local-currency threshold, authored as split Cedar

Policy's gating beat (issue #9) needs a threshold Cedar can evaluate at the Gateway
boundary, before Code Interpreter's Home-currency conversion (issue #7) exists.
Converting first would mean duplicating or advancing Code Interpreter's conversion
logic ahead of the Gateway boundary — more plumbing than this primitive's learning
task calls for. We chose a flat numeric threshold evaluated against each hold's own
Local currency (e.g. `context.input.price > 500`), a deliberate simplification
consistent with this project's existing mock-data shortcuts (ADR-0004): economically
inconsistent across currencies, but keeps the Cedar condition to one line.

Approval is a single generic `approve-hold` Gateway action (not split by hold type),
added to Gateway's target and revising its tool set (issue #3) the same way ADR-0004
revised its response shape. The threshold rule is authored via NL-generation
(`agentcore add policy --generate`); the one-time-consumption temporal rule gating on
an unconsumed `approve-hold` event is hand-written Cedar, since AWS's own reference
examples hand-write temporal conditions rather than generate them.

## Consequences

Gateway's tool set (issue #3) gains a fifth action, `approve-hold`, alongside
search-flights/search-hotels/hold-flight/hold-hotel. The approval flow mirrors
Identity's Consent handshake (issue #6): Policy DENYs a Gated hold, the Concierge
surfaces the price to the Caller mid-conversation, the Caller approves, the Concierge
calls `approve-hold`, and the retried hold is ALLOWed once Policy's temporal condition
finds that unconsumed approval event.

## Revision (issue #20, first live deploy)

The temporal half of this design — a hand-written Dogwood rule matching an unconsumed
`approve-hold` event in the session's trajectory — never worked once deployed: every
action, once it reached full Policy evaluation, failed with a generic
`"An internal error occurred. Please retry later."`. The actual root cause, confirmed by
a live probe with the header stripped, was the Policy session header
(`x-amzn-bedrock-agentcore-policy-session-id`) the adapter sent on every call — it broke
every Gateway action regardless of which Cedar policy governed it, with or without any
Dogwood policy on the engine. An earlier diagnosis blamed the Dogwood policy itself
(that policies-only comparison looked like a clean 2-for-2 correlation, since removing
the temporal policies happened at the same time as other changes) — redeploying with the
temporal policies gone but the header still being sent reproduced the identical failure,
which is what led to isolating the header as the real cause. Full diagnosis history in
[issue #20's comments](https://github.com/ricardohui/agentcore-wayfarer/issues/20#issuecomment-5578615988).

Since this project's purpose is learning AgentCore's primitives rather than shipping
this exact rule, the gate is redesigned as two stateless, per-request Cedar rules:

```
permit(principal, action in [hold-flight, hold-hotel], resource == <gateway>)
when { context.input has price && context.input.price.lessThanOrEqual(decimal("500.0000")) };

permit(principal, action in [hold-flight, hold-hotel], resource == <gateway>)
when { context.input has approved && context.input.approved };
```

`approve-hold` stays a real, generic Gateway action — it no longer feeds a Policy rule,
but remains an explicit, traceable approval event (useful for the Observability ticket,
#21) and needs no schema redeploy. `hold-flight`/`hold-hotel` gain an optional
`approved` input that the retry sets to `true`. One-time consumption — the property the
temporal rule used to guarantee — moves to the Concierge's usecase layer: it tracks a
per-session approval flag, set by `approve-hold` and cleared after one successful gated
hold, so a second, unrelated expensive hold is gated again. This trades a Policy-side
guarantee for a Concierge-side one; the flag lives in the executor's process memory, so
a recycled Runtime microVM loses it and the Caller re-approves — acceptable for a
single-test-user learning build.

A second, independent bug surfaced during the same live verification pass: the real
Gateway returns a Policy denial as a genuine JSON-RPC-level error (the MCP SDK throws an
`McpError` for it), not a normal tool result with `isError: true`. `BookingGatewayAdapter`
only checked for the policy-enforcement wording on the `isError: true` path, so every
real denial fell through to its catch-all `GatewayUnavailable` branch instead of
`HoldGated` — meaning the Gated-hold flow had never actually worked against the real
Gateway, only against the test double, which never modeled this response shape. Fixed by
applying the same denial check in the `catch` block.

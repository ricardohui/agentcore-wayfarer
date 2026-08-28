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

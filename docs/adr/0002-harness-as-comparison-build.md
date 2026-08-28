# Harness ships as a standalone comparison build, not part of the Concierge

Runtime (ADR-0001's predecessor decision, issue #2) already committed the
Concierge to a custom Node.js handler wrapped in `BedrockAgentCoreApp` —
the "write your own loop" path. But per AWS's own architecture, Harness
(managed config-based agent loop) and Runtime (self-authored loop) are
alternative ways to host the *same* agent process, not layers you combine —
so Harness could not simply be bolted onto the already-decided Concierge
without contradicting that decision.

We considered reopening the Runtime decision (route the Concierge through
Harness instead) and rejected it — Runtime's custom-loop choice was
deliberate and still holds. Instead, Harness's learning task (issue #4) is
a standalone, throwaway build that reimplements the same scenario beat as
Gateway (issue #3) — the 3-city-trip search+hold flow — as pure Harness
config (model, system prompt, `agentcore_gateway` tool wired to the
existing Gateway target, execution limits), plus one per-invocation model
override to demonstrate Harness's no-redeploy property. It is never wired
into Wayfarer's live architecture; its value is the side-by-side contrast
with the Concierge's custom-code approach to the identical beat.

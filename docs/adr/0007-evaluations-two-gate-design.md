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

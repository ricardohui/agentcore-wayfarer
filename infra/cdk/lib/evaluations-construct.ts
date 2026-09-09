import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { CONCIERGE_MODEL_ID } from "../../../src/concierge/infra/model-id";
import { WAYFARER_SCENARIO_BUDGET_USD } from "../../../src/evaluations/scenario-budget";

const BUDGET_GATE_LAMBDA_BUNDLE_DIR = path.join(__dirname, "../../../dist/evaluations/budget-gate-evaluator");

const ITINERARY_QUALITY_INSTRUCTIONS = `You are judging one Wayfarer trip-planning session for itinerary quality.

Read the full session in {context}. The Caller stated their destination cities, travel
dates, and any other constraints (e.g. a budget) in conversation; the Concierge searched
and held flights and hotels through its booking tools in response.

Judge two things, and label the session "Pass" only if BOTH hold:

1. Relevant: every flight and hotel hold the Concierge made matches the destinations,
   dates, and constraints the Caller actually stated. A hold for a city, date, or
   preference the Caller never asked for is not relevant, even if it was cheap or
   otherwise well-chosen.
2. Complete: by the end of the session, all 3 of Wayfarer's fixed scenario cities — Tokyo,
   Paris, and New York, regardless of which ones the Caller happened to bring up — have BOTH
   a flight hold and a hotel hold. A city left with only one of the two, or with neither,
   makes the session incomplete, even if the Caller never explicitly asked about that city.

Label "Fail" if either relevant or complete does not hold, and explain which one failed
and why.`;

// Evaluations (issue #23 / ADR-0007): two AND'd custom evaluators judging
// Wayfarer itinerary quality — a TOOL_CALL-level deterministic gate reading
// Code Interpreter's Running total, and a SESSION-level holistic LLM judge
// for relevant+complete. A run passes only when both gates PASS; that AND is
// evaluated by whoever reads the two Evaluate results back (this ticket's
// on-demand scenario scripts, not a resource this stack provisions), not
// enforced by either evaluator alone.
export class EvaluationsConstruct extends cdk.Resource {
  public readonly budgetGateLambda: lambda.Function;
  public readonly budgetGateEvaluator: agentcore.Evaluator;
  public readonly itineraryQualityEvaluator: agentcore.Evaluator;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // The deterministic gate (Running total <= budget): a code-based
    // evaluator, since AgentCore Evaluations has no built-in numeric-
    // threshold evaluator type — this is CDK's aws-bedrockagentcore L1's
    // only supported way to express "compare a tool call's own output
    // against an exact number" (see docs/adr/0007). Reads
    // WAYFARER_SCENARIO_BUDGET_USD, not a hand-typed literal, so the number
    // enforced here can't drift from what the scenario scripts narrate to
    // the Caller.
    this.budgetGateLambda = new lambda.Function(this, "BudgetGateLambda", {
      functionName: "wayfarer-evaluations-budget-gate",
      description: `Wayfarer Evaluations budget gate (issue #23 / ADR-0007) - Running total <= $${WAYFARER_SCENARIO_BUDGET_USD}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "app.handler",
      code: lambda.Code.fromAsset(BUDGET_GATE_LAMBDA_BUNDLE_DIR),
      timeout: cdk.Duration.seconds(30),
    });

    // EvaluatorConfig.codeBased() grants bedrock-agentcore.amazonaws.com
    // invoke on this Lambda, scoped to this evaluator resource - no manual
    // IAM wiring needed (unlike BookingGatewayConstruct's Gateway role,
    // which invokes a Lambda it doesn't own a scoped grant helper for).
    this.budgetGateEvaluator = new agentcore.Evaluator(this, "BudgetGateEvaluator", {
      evaluatorName: "wayfarer_budget_gate",
      description: `Wayfarer itinerary-quality deterministic gate (issue #23 / ADR-0007) - Running total <= $${WAYFARER_SCENARIO_BUDGET_USD}`,
      level: agentcore.EvaluationLevel.TOOL_CALL,
      evaluatorConfig: agentcore.EvaluatorConfig.codeBased({ lambdaFunction: this.budgetGateLambda }),
    });

    // The holistic gate (relevant + complete): an LLM-as-a-Judge evaluator,
    // since both criteria are inherently fuzzy natural-language judgments
    // over the whole session, not something a deterministic check can
    // express (docs/adr/0007). Reuses CONCIERGE_MODEL_ID as the judge model
    // rather than introducing a second foundation model the AWS account
    // would need separate access provisioning for.
    this.itineraryQualityEvaluator = new agentcore.Evaluator(this, "ItineraryQualityEvaluator", {
      evaluatorName: "wayfarer_itinerary_quality",
      description: "Wayfarer itinerary-quality holistic LLM judge (issue #23 / ADR-0007) - relevant + complete",
      level: agentcore.EvaluationLevel.SESSION,
      evaluatorConfig: agentcore.EvaluatorConfig.llmAsAJudge({
        instructions: ITINERARY_QUALITY_INSTRUCTIONS,
        modelId: CONCIERGE_MODEL_ID,
        ratingScale: agentcore.EvaluatorRatingScale.categorical([
          { label: "Pass", definition: "Every hold is relevant to what the Caller asked for, and all 3 scenario cities (Tokyo, Paris, New York) end the session with both a flight hold and a hotel hold." },
          { label: "Fail", definition: "At least one hold doesn't match what the Caller asked for, or at least one of the 3 scenario cities is missing a flight hold, a hotel hold, or both." },
        ]),
      }),
    });
  }
}

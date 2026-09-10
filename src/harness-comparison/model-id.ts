import { CONCIERGE_MODEL_ID } from "../concierge/infra/model-id";

// The Harness's declaratively-configured default model — same model as the
// live Concierge (CONCIERGE_MODEL_ID) so the comparison is apples-to-apples.
export const HARNESS_DEFAULT_MODEL_ID = CONCIERGE_MODEL_ID;

// A different Bedrock model, used only by the per-invocation override demo
// (issue #22's acceptance criterion 2) to show Harness serving a call from a
// different model with no redeploy of the Harness resource itself.
export const HARNESS_OVERRIDE_MODEL_ID = "anthropic.claude-3-5-haiku-20241022-v1:0";

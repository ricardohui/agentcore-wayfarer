import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import type { Construct } from "constructs";

const BLOCKED_INPUT_MESSAGE = "I can't help with that — could you try asking in a different way?";
const BLOCKED_OUTPUT_MESSAGE = "Sorry, I can't share that response — please try asking again.";

const CONTEXTUAL_GROUNDING_THRESHOLD = 0.7;

// The Wayfarer Concierge's Guardrail (issue #26 / ADR-0011): blanket
// protection (content filters, denied topics, a narrow PII policy) on every
// Caller turn, plus contextual grounding for the one tool result carrying
// genuinely external-sourced free text (Knowledge Base retrieval — see
// GROUNDED_TOOL_NAME in bedrock-converse-model-client.ts). No CDK L2
// construct exists for Bedrock Guardrails (confirmed against the installed
// aws-cdk-lib version) — built directly against the two L1s.
export class GuardrailConstruct extends cdk.Resource {
  public readonly guardrail: bedrock.CfnGuardrail;
  public readonly version: bedrock.CfnGuardrailVersion;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.guardrail = new bedrock.CfnGuardrail(this, "Guardrail", {
      name: "wayfarer_concierge_guardrail",
      description: "Wayfarer Concierge content-safety guardrail (issue #26 / ADR-0011)",
      // Deliberately generic and identical in shape for both messages — no
      // per-filter-category differentiation, so a Caller can't reverse-
      // engineer which specific rule caught their message (ADR-0011).
      blockedInputMessaging: BLOCKED_INPUT_MESSAGE,
      blockedOutputsMessaging: BLOCKED_OUTPUT_MESSAGE,
      contentPolicyConfig: {
        filtersConfig: [
          // PROMPT_ATTACK is input-only — Bedrock rejects any non-NONE
          // output strength for it (confirmed live: "PROMPT ATTACK content
          // filter strength for response must be NONE"). A prompt attack is
          // by definition something a Caller does to the model, not
          // something the model's own response could itself be.
          { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" },
          contentFilter("MISCONDUCT", "HIGH"),
          contentFilter("HATE", "MEDIUM"),
          contentFilter("INSULTS", "MEDIUM"),
          contentFilter("SEXUAL", "MEDIUM"),
          contentFilter("VIOLENCE", "MEDIUM"),
        ],
      },
      // Denied-topic definitions stay positive and scoped to a *personal*
      // matter (a personal health condition, a personal legal dispute,
      // personal investment choices) rather than listing exclusions —
      // AWS's own best practice warns against negative/exception-carrying
      // definitions, and definitions are capped at 200 characters. Scoping
      // to "personal" naturally keeps travel-relevant health/safety
      // questions (e.g. "is tap water safe to drink in Tokyo?") and
      // destination entry-requirement facts (e.g. visa rules) out of scope,
      // without needing exclusion language (ADR-0011).
      topicPolicyConfig: {
        topicsConfig: [
          deniedTopic(
            "financial-advice",
            "Personalized advice about investing, saving, or managing money, such as which stocks, funds, " +
              "or financial products to choose.",
            [
              "What stocks should I invest in?",
              "How should I invest my savings?",
              "Should I refinance my mortgage?",
              "What's a good retirement savings strategy?",
            ],
          ),
          deniedTopic(
            "medical-advice",
            "Diagnosis, treatment, medication, or dosage recommendations for a personal health condition or symptom.",
            [
              "What medication should I take for my headache?",
              "Do I have the flu?",
              "What's the right dosage for this drug?",
              "How do I treat this injury?",
            ],
          ),
          deniedTopic(
            "legal-advice",
            "Legal advice or strategy for a personal legal matter, such as a lawsuit, contract dispute, " +
              "or immigration case.",
            [
              "Should I sue my landlord?",
              "How do I fight this lawsuit?",
              "Can you review this contract for me?",
              "What's my best legal defense here?",
            ],
          ),
          deniedTopic(
            "non-travel-questions",
            "General questions unrelated to travel planning, such as homework help, trivia, or writing code.",
            [
              "Can you help me with my math homework?",
              "Write me a Python script to sort a list.",
              "Who won the World Cup in 2018?",
              "What's the capital of Australia?",
            ],
          ),
        ],
      },
      // BLOCKs exactly 4 entity types (ADR-0011) — every other type (name,
      // address, phone, email) is left untouched, since Memory's whole
      // personalization feature (home airport, dietary/seat prefs, semantic
      // preferences) depends on that content flowing through unfiltered.
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          piiEntity("CREDIT_DEBIT_CARD_NUMBER"),
          piiEntity("US_SOCIAL_SECURITY_NUMBER"),
          piiEntity("US_PASSPORT_NUMBER"),
          piiEntity("DRIVER_ID"),
        ],
      },
      contextualGroundingPolicyConfig: {
        filtersConfig: [
          { type: "GROUNDING", threshold: CONTEXTUAL_GROUNDING_THRESHOLD },
          { type: "RELEVANCE", threshold: CONTEXTUAL_GROUNDING_THRESHOLD },
        ],
      },
    });

    // A numbered, pinned version (never DRAFT) — so the guardrail's behavior
    // in production can't change silently underneath a live deployment.
    this.version = new bedrock.CfnGuardrailVersion(this, "Version", {
      guardrailIdentifier: this.guardrail.attrGuardrailId,
      description: "Pinned version for the Concierge Runtime (issue #26 / ADR-0011)",
    });
  }
}

function contentFilter(type: string, strength: "HIGH" | "MEDIUM"): bedrock.CfnGuardrail.ContentFilterConfigProperty {
  return { type, inputStrength: strength, outputStrength: strength };
}

function deniedTopic(
  name: string,
  definition: string,
  examples: readonly string[],
): bedrock.CfnGuardrail.TopicConfigProperty {
  return { name, definition, examples: [...examples], type: "DENY" };
}

function piiEntity(type: string): bedrock.CfnGuardrail.PiiEntityConfigProperty {
  return { type, action: "BLOCK" };
}

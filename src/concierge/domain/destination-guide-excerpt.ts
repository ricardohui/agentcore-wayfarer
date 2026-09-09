import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

// One retrieved passage from the Knowledge Base's Retrieve tool (issue #21 /
// ADR-0009) — a value object, not identity-bearing: two excerpts with the
// same text/source are interchangeable. Only `content.text` is parsed out of
// Gateway's richer retrievalResults item shape (location/metadata/score) —
// this project's own ingested docs are text-only, so IMAGE/ROW/AUDIO/VIDEO
// content types never occur here.
export class DestinationGuideExcerpt {
  constructor(
    public readonly text: string,
    public readonly sourceUri: string | undefined,
    public readonly score: number | undefined,
  ) {}

  static parse(raw: unknown): Result<DestinationGuideExcerpt, ValidationError> {
    if (typeof raw !== "object" || raw === null) {
      return err(validationError("destinationGuideExcerpt", "must be an object"));
    }
    const record = raw as Record<string, unknown>;

    const content = record.content as { text?: unknown } | undefined;
    if (typeof content?.text !== "string") {
      return err(validationError("destinationGuideExcerpt.content.text", "must be a string"));
    }

    const location = record.location as { s3Location?: { uri?: unknown } } | undefined;
    const sourceUri = typeof location?.s3Location?.uri === "string" ? location.s3Location.uri : undefined;
    const score = typeof record.score === "number" ? record.score : undefined;

    return ok(new DestinationGuideExcerpt(content.text, sourceUri, score));
  }

  toJSON() {
    return {
      text: this.text,
      ...(this.sourceUri !== undefined ? { sourceUri: this.sourceUri } : {}),
      ...(this.score !== undefined ? { score: this.score } : {}),
    };
  }
}

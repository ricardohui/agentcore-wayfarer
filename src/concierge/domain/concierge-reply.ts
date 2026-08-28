import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export type ConciergeReply = string & { readonly __brand: "ConciergeReply" };

export function parseConciergeReply(value: string): Result<ConciergeReply, ValidationError> {
  if (value.trim().length === 0) {
    return err(validationError("conciergeReply", "must not be blank"));
  }

  return ok(value as ConciergeReply);
}

import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

// A fact the `user-preference` or `semantic` Memory Strategy (issue #16) has
// already extracted for a returning Caller — e.g. "home airport: NRT" or
// "avoids red-eyes". Stable facts and soft free-form preferences share this
// one shape; which Strategy produced it doesn't change how the Concierge uses it.
export type CallerPreference = string & { readonly __brand: "CallerPreference" };

export function parseCallerPreference(value: string): Result<CallerPreference, ValidationError> {
  if (value.trim().length === 0) {
    return err(validationError("callerPreference", "must not be blank"));
  }

  return ok(value as CallerPreference);
}

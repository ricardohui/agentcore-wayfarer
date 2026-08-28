import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export type RuntimeSessionId = string & { readonly __brand: "RuntimeSessionId" };

const MIN_RUNTIME_SESSION_ID_LENGTH = 33;

export function parseRuntimeSessionId(
  value: string,
): Result<RuntimeSessionId, ValidationError> {
  if (value.length < MIN_RUNTIME_SESSION_ID_LENGTH) {
    return err(
      validationError(
        "runtimeSessionId",
        `must be at least ${MIN_RUNTIME_SESSION_ID_LENGTH} characters long`,
      ),
    );
  }

  return ok(value as RuntimeSessionId);
}

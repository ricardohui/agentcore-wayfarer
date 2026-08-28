import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export type CallerMessage = string & { readonly __brand: "CallerMessage" };

const MAX_CALLER_MESSAGE_LENGTH = 4000;

export function parseCallerMessage(value: string): Result<CallerMessage, ValidationError> {
  if (value.trim().length === 0) {
    return err(validationError("callerMessage", "must not be blank"));
  }

  if (value.length > MAX_CALLER_MESSAGE_LENGTH) {
    return err(
      validationError("callerMessage", `must not exceed ${MAX_CALLER_MESSAGE_LENGTH} characters`),
    );
  }

  return ok(value as CallerMessage);
}

import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

// Identifies the Caller across sessions for Memory's long-term Strategies
// (issue #16). Fixed to a single placeholder until Identity (issue #17)
// revises it to the Caller's Cognito `sub`.
export type ActorId = string & { readonly __brand: "ActorId" };

export function parseActorId(value: string): Result<ActorId, ValidationError> {
  if (value.trim().length === 0) {
    return err(validationError("actorId", "must not be blank"));
  }
  // memory-namespaces.ts embeds actorId unescaped into namespace paths
  // (e.g. `/actor/${actorId}/preferences`) — a '/' would let one actor's id
  // resolve into a different actor's namespace.
  if (value.includes("/")) {
    return err(validationError("actorId", "must not contain '/'"));
  }
  return ok(value as ActorId);
}

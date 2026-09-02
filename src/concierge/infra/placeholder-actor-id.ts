import { parseActorId, type ActorId } from "../domain/actor-id";

// Every invocation resolves to this single actorId until Identity (issue #17)
// extracts the Caller's real Cognito `sub` from the inbound JWT.
const PLACEHOLDER_ACTOR_ID_VALUE = "wayfarer-placeholder-actor";

const parsed = parseActorId(PLACEHOLDER_ACTOR_ID_VALUE);
if (!parsed.ok) {
  throw new Error(`invalid PLACEHOLDER_ACTOR_ID_VALUE: ${parsed.error.message}`);
}

export const PLACEHOLDER_ACTOR_ID: ActorId = parsed.value;

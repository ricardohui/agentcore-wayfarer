import type { ActorId } from "./domain/actor-id";

// Shared between the CDK Memory construct (issue #16) and the real Memory
// adapter, so the Strategies' configured namespaces and the namespace an
// actor's preferences are retrieved from can't drift apart.
export function userPreferenceNamespace(actorId: ActorId): string {
  return `/actor/${actorId}/preferences`;
}

export function semanticPreferenceNamespace(actorId: ActorId): string {
  return `/actor/${actorId}/semantic`;
}

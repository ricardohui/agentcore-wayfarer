import type { CodeInterpreterStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { asyncIterableOf } from "./async-iterable";

// CodeInterpreterStreamOutput is a discriminated union requiring every
// member's other branches to be explicitly `undefined` — fixtures only ever
// need to set the one branch under test, so this casts in one place rather
// than at every call site.
export function codeInterpreterStream(
  event: Partial<CodeInterpreterStreamOutput>,
): AsyncIterable<CodeInterpreterStreamOutput> {
  return asyncIterableOf(event as CodeInterpreterStreamOutput);
}

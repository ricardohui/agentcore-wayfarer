import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";

// aws-sdk-client-mock resolves a command with a plain object, but
// InvokeHarnessResponse.stream is typed as AsyncIterable<InvokeHarnessStreamOutput> —
// a bare array satisfies that at runtime but not the type checker, so tests
// build their canned stream with this instead (mirrors
// tests/concierge/support/async-iterable.ts's asyncIterableOf, kept local so
// this comparison build's own test slice has no import into Concierge's).
export function harnessStream(
  ...events: ReadonlyArray<Partial<InvokeHarnessStreamOutput>>
): AsyncIterable<InvokeHarnessStreamOutput> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event as InvokeHarnessStreamOutput;
      }
    },
  };
}

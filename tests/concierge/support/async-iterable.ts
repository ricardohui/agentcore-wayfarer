// aws-sdk-client-mock resolves a command with a plain object, but the SDK's
// generated response types (e.g. InvokeCodeInterpreterResponse.stream) type
// streaming fields as AsyncIterable<T> — a bare array satisfies that at
// runtime (`for await` falls back to Symbol.iterator) but not the type
// checker, so tests build their canned stream with this instead.
export function asyncIterableOf<TItem>(...items: TItem[]): AsyncIterable<TItem> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) {
        yield item;
      }
    },
  };
}

export type MemoryError =
  | { readonly type: "MemoryUnavailable"; readonly message: string }
  | { readonly type: "MalformedResponse"; readonly message: string };

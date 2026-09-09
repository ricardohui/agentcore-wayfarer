export type KnowledgeBaseError =
  | { readonly type: "KnowledgeBaseUnavailable"; readonly message: string }
  | { readonly type: "MalformedResponse"; readonly message: string };

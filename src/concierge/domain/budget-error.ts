// Code Interpreter's budget/currency math (issue #18): SandboxUnavailable
// covers a failure to reach the sandbox at all (network, throttling, a
// missing session) — ExecutionFailed covers a sandbox that ran but produced
// something unusable (the executed code raised, e.g. an unmapped currency,
// or its stdout wasn't the expected structured result).
export type BudgetError =
  | { readonly type: "SandboxUnavailable"; readonly message: string }
  | { readonly type: "ExecutionFailed"; readonly message: string };

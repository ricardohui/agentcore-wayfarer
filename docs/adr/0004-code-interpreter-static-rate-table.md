# Code Interpreter's currency conversion uses a static mock rate table, not a live forex API

Code Interpreter's budget/currency beat (issue #7) needs an exchange rate source. Same
trade-off as ADR-0001 and ADR-0003: a real forex API is more realistic but adds API-key
management and an external dependency unrelated to what Code Interpreter itself teaches —
sandboxed execution, session state, structured stdout. We chose a static mock rate table
embedded in the executed code, which also lets the session run in Sandbox network mode
(no internet egress) rather than Public, the tighter of Code Interpreter's two isolation
modes.

As a consequence, Gateway's mock data (issue #3, already closed) is revised: `search-flights`
and `search-hotels` prices now carry a per-item Local currency code, not a bare number, so
there is something for Code Interpreter to convert. Gateway's own decision (mock Lambda,
`lambda_iam` auth, tool set) is unchanged — this only adds a field to its response shape.

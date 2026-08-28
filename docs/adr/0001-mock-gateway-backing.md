# Gateway tools backed by mock Lambdas, not real travel APIs

Wayfarer's Gateway target (issue #3) needs a flight/hotel search-and-hold
tool set. A real API (e.g. Amadeus) would be more realistic but adds API
key management, quotas, and a second learning curve unrelated to
AgentCore's own mechanics. We chose mock Lambdas returning randomized
canned data behind a single OpenAPI schema and one router Lambda
(`lambda_iam` auth, no credential provider), so the Gateway ticket stays
focused on OpenAPI-to-MCP tool generation rather than travel-API
integration. Gateway's tool set is scoped to booking-domain actions only
(search-flights, hold-flight, search-hotels, hold-hotel) — currency
conversion stays with Code Interpreter and live price-checking stays with
Browser Tool, so the three primitives don't overlap.

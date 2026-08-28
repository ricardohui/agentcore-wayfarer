# Identity: mocked OAuth2 calendar target, but a live consent handshake

Identity's Delegated credential (issue #6) needs an external target to act against.
Same trade-off as ADR-0001: a real Google Calendar integration teaches Google's OAuth
console setup (consent screen, redirect-URI verification, test-user allowlisting) more
than it teaches AgentCore Identity's own mechanics. We chose a minimal Lambda-backed
OAuth2 authorization server (`/authorize` + `/token`, real authorization-code+PKCE flow,
real signed tokens) fronting a mock calendar-events store, registered with AgentCore as
a custom OAuth2 vendor — same mock-backing shape as Gateway's target.

Unlike the token itself, the *handshake* stays real: the Concierge's first calendar
write fails "not authorized," it surfaces AgentCore's authorization URL to the Caller
mid-conversation, and only succeeds on retry once the Caller has approved and the token
vault holds a credential. We considered pre-authorizing before the demo conversation
starts (simpler, silent) and rejected it — the handshake is the part of Identity worth
depth on, not the calendar data behind it.

The Actor decision (Memory, issue #5) is revised as a consequence: actorId is now the
Caller's Cognito `sub`, not a standalone placeholder, so Memory's long-term facts key off
the same inbound identity Identity establishes.

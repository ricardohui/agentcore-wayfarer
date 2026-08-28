# Browser Tool price-checks a mock site, not a real travel site

Browser Tool's price-check beat (issue #8) needs a site to browse. Same trade-off as
ADR-0001, ADR-0003, and ADR-0004: a real travel site is more realistic, but AWS's own
AgentCore Browser troubleshooting docs flag anti-bot/CAPTCHA defenses on real travel sites
as a routine failure mode, undermining a repeatable demo — mitigations (Web Bot Auth,
still preview; live-view human handoff) are more scope than this primitive's learning task.
We chose a minimal static price page, CDK-deployed to S3, with prices randomized
independently of Gateway's mock catalog (issue #3) so a Live price can plausibly diverge
from a candidate's Quoted price.

## Consequences

The price-check runs as a one-shot Browser session per candidate (navigate, read price,
close) immediately before its hold call, always — not agent discretion. A Live price that
differs from Quoted price is surfaced to the Caller and the hold proceeds at Live price;
Live price (not Quoted price) is what Code Interpreter's Running total (issue #7) converts
and accumulates.

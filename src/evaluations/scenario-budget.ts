// Evaluations' deterministic gate (issue #23 / ADR-0007): the Home-currency
// (USD) ceiling the happy-path scenario transcript is steered to stay under
// and the over-budget transcript is steered to exceed. Shared by the
// scenario-run probe script's steered caller messages and the budget-gate
// evaluator Lambda's comparison, so the number enforced and the number
// narrated to the Caller can't drift apart — same reasoning as
// hold-approval-threshold.ts's HOLD_APPROVAL_THRESHOLD_LOCAL_AMOUNT.
// Calibrated against real mock-catalog prices from the final live-generated
// dataset itself (issue #23's canonical 3-transcript set, generated after
// the split-telemetry pipeline shipped), not guessed: the happy-path
// transcript's real Code Interpreter Running total landed at $3,383.80, the
// over-budget transcript's at $3,753.95 — "most expensive available"
// doesn't reliably run an order of magnitude above "most affordable
// available" in this mock catalog's price ranges (each recalibration in
// this file's history picked a threshold from the previous dataset, which
// then landed too close to the *next* dataset's own totals once the
// scenarios were regenerated for an unrelated reason - the two totals
// genuinely vary by only 10-15% run to run), so a single threshold has to
// sit in the gap actually observed between the two specific transcripts
// this dataset ships with, not a round number picked in advance.
export const WAYFARER_SCENARIO_BUDGET_USD = 3600;

// Policy's flat Local-currency approval threshold (issue #20 / ADR-0006): a
// hold-flight/hold-hotel priced above this amount, in whatever currency its
// own candidate is priced in, is Gated behind an approve-hold event. Shared
// by the CDK stack's Cedar policy statement so the enforced number and any
// reference to it in code/docs can't drift apart.
export const HOLD_APPROVAL_THRESHOLD_LOCAL_AMOUNT = 500;

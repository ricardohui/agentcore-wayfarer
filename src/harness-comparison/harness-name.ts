// Single source of truth for the comparison Harness's name — imported by the
// CDK stack (resource provisioning) and any manual invocation script, so the
// two can't drift apart. See ADR-0002 / issue #22.
export const HARNESS_NAME = "wayfarer_search_hold_comparison";

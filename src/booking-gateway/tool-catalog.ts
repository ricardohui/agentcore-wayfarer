// Single source of truth for Gateway's booking target's tools (issue #15 /
// ADR-0001, extended by issue #20 / ADR-0006) — imported by both the
// Concierge's BedrockConverseModelClient (the contract shown to the model)
// and the CDK stack (the contract Gateway's mcp.lambda target actually
// enforces, and what Policy's Cedar schema is generated from), so the two
// can't drift apart.
export type BookingToolName =
  | "search-flights"
  | "search-hotels"
  | "hold-flight"
  | "hold-hotel"
  | "approve-hold";

export type BookingToolDefinition = {
  readonly name: BookingToolName;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, { readonly type: string; readonly description?: string }>;
    readonly required: readonly string[];
  };
};

const CITY_DESCRIPTION = "One of Wayfarer's 3 scenario cities: TOKYO, PARIS, or NEW_YORK.";

// Populated internally from the candidate's searched price, not by the
// model — declared here so Policy's Cedar schema (auto-generated from this
// same tool definition, issue #20 / ADR-0006) has a `context.input.price`
// field to gate hold-flight/hold-hotel on.
const PRICE_PROPERTY = {
  type: "number",
  description: "Do not set — populated automatically from the candidate's previously searched price.",
} as const;

// Do not set — populated automatically once the Caller has approved a prior
// Gated hold in this session (issue #20 / ADR-0006, revised). Lets Policy's
// approved-retry Cedar rule stay stateless: it only reads whether *this*
// request carries `approved: true`, never a session's history.
const APPROVED_PROPERTY = {
  type: "boolean",
  description: "Do not set — populated automatically once the Caller has approved a prior Gated hold.",
} as const;

export const BOOKING_TOOL_DEFINITIONS: readonly BookingToolDefinition[] = [
  {
    name: "search-flights",
    description: "Search for flight candidates to one of Wayfarer's 3 scenario cities.",
    inputSchema: {
      type: "object",
      properties: { destination: { type: "string", description: CITY_DESCRIPTION } },
      required: ["destination"],
    },
  },
  {
    name: "search-hotels",
    description: "Search for hotel candidates in one of Wayfarer's 3 scenario cities.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", description: CITY_DESCRIPTION } },
      required: ["city"],
    },
  },
  {
    name: "hold-flight",
    description: "Place a tentative hold on a flight candidate returned by search-flights.",
    inputSchema: {
      type: "object",
      properties: { candidateId: { type: "string" }, price: PRICE_PROPERTY, approved: APPROVED_PROPERTY },
      required: ["candidateId"],
    },
  },
  {
    name: "hold-hotel",
    description: "Place a tentative hold on a hotel candidate returned by search-hotels.",
    inputSchema: {
      type: "object",
      properties: { candidateId: { type: "string" }, price: PRICE_PROPERTY, approved: APPROVED_PROPERTY },
      required: ["candidateId"],
    },
  },
  {
    name: "approve-hold",
    description:
      "Record the Caller's explicit approval for a hold that was Gated for exceeding the approval threshold. Call this only after the Caller has approved, then retry the hold-flight/hold-hotel call.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

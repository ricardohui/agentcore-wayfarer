// Single source of truth for Gateway's booking target's 4 tools (issue #15 /
// ADR-0001) — imported by both the Concierge's BedrockConverseModelClient
// (the contract shown to the model) and the CDK stack (the contract Gateway's
// mcp.lambda target actually enforces), so the two can't drift apart.
export type BookingToolName = "search-flights" | "search-hotels" | "hold-flight" | "hold-hotel";

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
      properties: { candidateId: { type: "string" } },
      required: ["candidateId"],
    },
  },
  {
    name: "hold-hotel",
    description: "Place a tentative hold on a hotel candidate returned by search-hotels.",
    inputSchema: {
      type: "object",
      properties: { candidateId: { type: "string" } },
      required: ["candidateId"],
    },
  },
];

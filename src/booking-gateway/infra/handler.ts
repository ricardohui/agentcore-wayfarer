import { parseNonBlankId } from "../../concierge/domain/non-blank-id";
import { parseScenarioCity } from "../../concierge/domain/scenario-city";
import { createHold, generateFlightCandidates, generateHotelCandidates } from "./mock-catalog";

// The minimal shape this Lambda depends on from AWS Lambda's Context object —
// AgentCore Gateway puts the invoked tool's name at
// clientContext.custom.bedrockAgentCoreToolName, formatted
// "{targetName}___{toolName}" (see "Understand how AgentCore Gateway tools
// are named").
export type GatewayLambdaContext = {
  readonly clientContext?: { readonly custom?: Record<string, unknown> };
};

const TOOL_NAME_SEPARATOR = "___";

export async function handler(
  event: Record<string, unknown>,
  context: GatewayLambdaContext,
): Promise<unknown> {
  const operation = extractOperation(context);
  if (!operation) {
    return errorResponse("missing bedrockAgentCoreToolName in Lambda context");
  }

  switch (operation) {
    case "search-flights": {
      const destination = parseScenarioCity(String(event.destination ?? ""));
      if (!destination.ok) {
        return errorResponse(destination.error.message);
      }
      return generateFlightCandidates(destination.value);
    }
    case "search-hotels": {
      const city = parseScenarioCity(String(event.city ?? ""));
      if (!city.ok) {
        return errorResponse(city.error.message);
      }
      return generateHotelCandidates(city.value);
    }
    case "hold-flight":
    case "hold-hotel": {
      const candidateId = parseNonBlankId<"CandidateId">("candidateId", String(event.candidateId ?? ""));
      if (!candidateId.ok) {
        return errorResponse(candidateId.error.message);
      }
      return createHold();
    }
    default:
      return errorResponse(`unknown operation: ${operation}`);
  }
}

function extractOperation(context: GatewayLambdaContext): string | undefined {
  const toolName = context.clientContext?.custom?.bedrockAgentCoreToolName;
  if (typeof toolName !== "string") {
    return undefined;
  }
  const separatorIndex = toolName.indexOf(TOOL_NAME_SEPARATOR);
  return separatorIndex === -1 ? toolName : toolName.slice(separatorIndex + TOOL_NAME_SEPARATOR.length);
}

function errorResponse(message: string): { error: string } {
  return { error: message };
}

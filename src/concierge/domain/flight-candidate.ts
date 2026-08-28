import { LocalPrice } from "./local-price";
import { parseNonBlankId } from "./non-blank-id";
import { parseScenarioCity, type ScenarioCity } from "./scenario-city";
import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export type FlightCandidateId = string & { readonly __brand: "FlightCandidateId" };

export class FlightCandidate {
  constructor(
    public readonly candidateId: FlightCandidateId,
    public readonly destination: ScenarioCity,
    public readonly airline: string,
    public readonly price: LocalPrice,
  ) {}

  static parse(raw: unknown): Result<FlightCandidate, ValidationError> {
    if (typeof raw !== "object" || raw === null) {
      return err(validationError("flightCandidate", "must be an object"));
    }
    const record = raw as Record<string, unknown>;

    const candidateId = parseNonBlankId<"FlightCandidateId">(
      "flightCandidate.candidateId",
      String(record.candidateId ?? ""),
    );
    if (!candidateId.ok) {
      return candidateId;
    }

    const destination = parseScenarioCity(String(record.destination ?? ""));
    if (!destination.ok) {
      return destination;
    }

    const airline = String(record.airline ?? "");
    if (airline.trim().length === 0) {
      return err(validationError("flightCandidate.airline", "must not be blank"));
    }

    const priceRecord = record.price as { amount?: unknown; currency?: unknown } | undefined;
    const price = LocalPrice.parse(Number(priceRecord?.amount), String(priceRecord?.currency ?? ""));
    if (!price.ok) {
      return price;
    }

    return ok(new FlightCandidate(candidateId.value, destination.value, airline, price.value));
  }
}

import { LocalPrice } from "./local-price";
import { parseNonBlankId } from "./non-blank-id";
import { parseScenarioCity, type ScenarioCity } from "./scenario-city";
import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export type HotelCandidateId = string & { readonly __brand: "HotelCandidateId" };

export class HotelCandidate {
  constructor(
    public readonly candidateId: HotelCandidateId,
    public readonly city: ScenarioCity,
    public readonly hotelName: string,
    public readonly price: LocalPrice,
  ) {}

  static parse(raw: unknown): Result<HotelCandidate, ValidationError> {
    if (typeof raw !== "object" || raw === null) {
      return err(validationError("hotelCandidate", "must be an object"));
    }
    const record = raw as Record<string, unknown>;

    const candidateId = parseNonBlankId<"HotelCandidateId">(
      "hotelCandidate.candidateId",
      String(record.candidateId ?? ""),
    );
    if (!candidateId.ok) {
      return candidateId;
    }

    const city = parseScenarioCity(String(record.city ?? ""));
    if (!city.ok) {
      return city;
    }

    const hotelName = String(record.hotelName ?? "");
    if (hotelName.trim().length === 0) {
      return err(validationError("hotelCandidate.hotelName", "must not be blank"));
    }

    const priceRecord = record.price as { amount?: unknown; currency?: unknown } | undefined;
    const price = LocalPrice.parse(Number(priceRecord?.amount), String(priceRecord?.currency ?? ""));
    if (!price.ok) {
      return price;
    }

    return ok(new HotelCandidate(candidateId.value, city.value, hotelName, price.value));
  }
}

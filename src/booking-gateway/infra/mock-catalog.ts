import { type ScenarioCity } from "../../concierge/domain/scenario-city";

// ADR-0001: mock data, randomized independently of any real travel API — the
// point is Gateway's OpenAPI/Lambda-to-MCP mechanics, not travel-data realism.
const CANDIDATE_COUNT = 3;
const HOLD_EXPIRY_MINUTES = 30;

const CURRENCY_BY_CITY: Record<ScenarioCity, string> = { TOKYO: "JPY", PARIS: "EUR", NEW_YORK: "USD" };
const BASE_FLIGHT_AMOUNT_BY_CITY: Record<ScenarioCity, number> = { TOKYO: 70000, PARIS: 400, NEW_YORK: 350 };
const BASE_HOTEL_AMOUNT_BY_CITY: Record<ScenarioCity, number> = { TOKYO: 25000, PARIS: 150, NEW_YORK: 200 };
const AIRLINES = ["ANA", "JAL", "Air France", "Delta", "United"];
const HOTEL_NAMES_BY_CITY: Record<ScenarioCity, readonly string[]> = {
  TOKYO: ["Park Hyatt Tokyo", "Shibuya Excel Hotel", "Tokyo Station Hotel"],
  PARIS: ["Hotel de Ville", "Le Marais Boutique", "Champs-Elysees Plaza"],
  NEW_YORK: ["Times Square Suites", "Brooklyn Bridge Inn", "Central Park Grand"],
};

export function generateFlightCandidates(destination: ScenarioCity) {
  return Array.from({ length: CANDIDATE_COUNT }, (_, index) => ({
    candidateId: `flight-${destination}-${index}-${randomSuffix()}`,
    destination,
    airline: randomFrom(AIRLINES),
    price: { amount: randomAmount(BASE_FLIGHT_AMOUNT_BY_CITY[destination]), currency: CURRENCY_BY_CITY[destination] },
  }));
}

export function generateHotelCandidates(city: ScenarioCity) {
  const names = HOTEL_NAMES_BY_CITY[city];
  return Array.from({ length: CANDIDATE_COUNT }, (_, index) => ({
    candidateId: `hotel-${city}-${index}-${randomSuffix()}`,
    city,
    hotelName: names[index % names.length],
    price: { amount: randomAmount(BASE_HOTEL_AMOUNT_BY_CITY[city]), currency: CURRENCY_BY_CITY[city] },
  }));
}

export function createHold() {
  return {
    holdId: `hold-${randomSuffix()}`,
    status: "held",
    expiresAt: new Date(Date.now() + HOLD_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };
}

function randomAmount(base: number): number {
  return Math.round(base * (1 + Math.random()));
}

function randomFrom<TValue>(values: readonly TValue[]): TValue {
  const value = values[Math.floor(Math.random() * values.length)];
  if (value === undefined) {
    throw new Error("randomFrom received an empty array");
  }
  return value;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

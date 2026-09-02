import { parseActorId, type ActorId } from "../../../src/concierge/domain/actor-id";
import { parseCallerMessage, type CallerMessage } from "../../../src/concierge/domain/caller-message";
import { parseCallerPreference, type CallerPreference } from "../../../src/concierge/domain/caller-preference";
import { parseConciergeReply, type ConciergeReply } from "../../../src/concierge/domain/concierge-reply";
import { FlightCandidate } from "../../../src/concierge/domain/flight-candidate";
import { Hold } from "../../../src/concierge/domain/hold";
import { HotelCandidate } from "../../../src/concierge/domain/hotel-candidate";
import { parseRuntimeSessionId, type RuntimeSessionId } from "../../../src/concierge/domain/runtime-session-id";
import type { ScenarioCity } from "../../../src/concierge/domain/scenario-city";

function unwrap<TValue>(result: { ok: boolean; value?: TValue }): TValue {
  if (!result.ok) {
    throw new Error("object mother received an invalid fixture value");
  }
  return result.value as TValue;
}

export function aRuntimeSessionId(suffix = "aaaa"): RuntimeSessionId {
  return unwrap(parseRuntimeSessionId(`test-session-${suffix}`.padEnd(33, "-")));
}

export function anActorId(suffix = "1"): ActorId {
  return unwrap(parseActorId(`test-actor-${suffix}`));
}

export function aCallerPreference(text = "home airport: NRT"): CallerPreference {
  return unwrap(parseCallerPreference(text));
}

export function aCallerMessage(text = "Plan me a trip to Tokyo"): CallerMessage {
  return unwrap(parseCallerMessage(text));
}

export function aConciergeReply(text = "Sure, let's start with your dates."): ConciergeReply {
  return unwrap(parseConciergeReply(text));
}

export function aFlightCandidate(overrides: {
  candidateId?: string;
  destination?: ScenarioCity;
  airline?: string;
  price?: { amount: number; currency: string };
} = {}): FlightCandidate {
  return unwrap(
    FlightCandidate.parse({
      candidateId: overrides.candidateId ?? "flight-1",
      destination: overrides.destination ?? "TOKYO",
      airline: overrides.airline ?? "ANA",
      price: overrides.price ?? { amount: 82000, currency: "JPY" },
    }),
  );
}

export function aHotelCandidate(overrides: {
  candidateId?: string;
  city?: ScenarioCity;
  hotelName?: string;
  price?: { amount: number; currency: string };
} = {}): HotelCandidate {
  return unwrap(
    HotelCandidate.parse({
      candidateId: overrides.candidateId ?? "hotel-1",
      city: overrides.city ?? "TOKYO",
      hotelName: overrides.hotelName ?? "Park Hyatt Tokyo",
      price: overrides.price ?? { amount: 45000, currency: "JPY" },
    }),
  );
}

export function aHold(overrides: { holdId?: string; expiresAt?: string } = {}): Hold {
  return unwrap(
    Hold.parse({
      holdId: overrides.holdId ?? "hold-1",
      status: "held",
      expiresAt: overrides.expiresAt ?? "2026-09-01T00:00:00.000Z",
    }),
  );
}

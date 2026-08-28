import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

// Wayfarer's 3-city trip scenario (issue #13's course-outline spec) — every
// Gateway search/hold candidate is scoped to one of these.
export const SCENARIO_CITIES = ["TOKYO", "PARIS", "NEW_YORK"] as const;

export type ScenarioCity = (typeof SCENARIO_CITIES)[number];

export function parseScenarioCity(value: string): Result<ScenarioCity, ValidationError> {
  if ((SCENARIO_CITIES as readonly string[]).includes(value)) {
    return ok(value as ScenarioCity);
  }
  return err(validationError("scenarioCity", `must be one of ${SCENARIO_CITIES.join(", ")}`));
}

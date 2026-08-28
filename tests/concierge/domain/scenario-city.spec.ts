import { describe, expect, it } from "vitest";
import { parseScenarioCity, SCENARIO_CITIES } from "../../../src/concierge/domain/scenario-city";

describe("parseScenarioCity", () => {
  it.each(SCENARIO_CITIES)("accepts %s as one of Wayfarer's 3 scenario cities", (city) => {
    expect(parseScenarioCity(city)).toEqual({ ok: true, value: city });
  });

  it("rejects a city outside the 3 scenario cities", () => {
    const result = parseScenarioCity("LONDON");

    expect(result).toEqual({
      ok: false,
      error: {
        type: "ValidationError",
        field: "scenarioCity",
        message: `must be one of ${SCENARIO_CITIES.join(", ")}`,
      },
    });
  });
});

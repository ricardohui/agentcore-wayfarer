import { describe, expect, it } from "vitest";
import { parseActorId } from "../../../src/concierge/domain/actor-id";

describe("parseActorId", () => {
  it("accepts a non-blank id", () => {
    const result = parseActorId("wayfarer-placeholder-actor");

    expect(result).toEqual({ ok: true, value: "wayfarer-placeholder-actor" });
  });

  it("rejects a blank id", () => {
    const result = parseActorId("   ");

    expect(result).toEqual({
      ok: false,
      error: { type: "ValidationError", field: "actorId", message: "must not be blank" },
    });
  });

  it("rejects an id containing '/', since it's embedded unescaped into Memory namespace paths", () => {
    const result = parseActorId("actor/../other-actor");

    expect(result).toEqual({
      ok: false,
      error: { type: "ValidationError", field: "actorId", message: "must not contain '/'" },
    });
  });
});

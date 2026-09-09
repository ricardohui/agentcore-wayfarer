import { describe, expect, it } from "vitest";
import { DestinationGuideExcerpt } from "../../../src/concierge/domain/destination-guide-excerpt";

describe("DestinationGuideExcerpt.parse", () => {
  it("parses a well-formed raw retrievalResults item from Gateway's Retrieve tool", () => {
    const result = DestinationGuideExcerpt.parse({
      content: { type: "TEXT", text: "Visa on arrival is available for stays under 90 days." },
      location: { type: "S3", s3Location: { uri: "s3://wayfarer-destination-guides/tokyo.md" } },
      score: 0.87,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("Visa on arrival is available for stays under 90 days.");
      expect(result.value.sourceUri).toBe("s3://wayfarer-destination-guides/tokyo.md");
      expect(result.value.score).toBe(0.87);
    }
  });

  it("parses an item with no location or score", () => {
    const result = DestinationGuideExcerpt.parse({ content: { type: "TEXT", text: "Pack layers for spring." } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("Pack layers for spring.");
      expect(result.value.sourceUri).toBeUndefined();
      expect(result.value.score).toBeUndefined();
    }
  });

  it("rejects an item with no content text", () => {
    const result = DestinationGuideExcerpt.parse({ content: { type: "TEXT" } });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "destinationGuideExcerpt.content.text" }),
    });
  });

  it("rejects a non-object raw value", () => {
    const result = DestinationGuideExcerpt.parse("not an object");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "ValidationError", field: "destinationGuideExcerpt" }),
    });
  });
});

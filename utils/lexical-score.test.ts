import { describe, it, expect } from "vitest";
import { lexicalOverlapScore } from "@/utils/lexical-score";

describe("lexicalOverlapScore", () => {
  it("returns 1 for a verbatim substring match, case-insensitively", () => {
    expect(lexicalOverlapScore("CloudNova", "Supplier: CloudNova Software")).toBe(1);
    expect(lexicalOverlapScore("cloudnova", "Supplier: CloudNova Software")).toBe(1);
  });

  it("returns the fraction of query tokens found in the text when there is no verbatim match", () => {
    expect(lexicalOverlapScore("CloudNova invoice details", "Supplier: CloudNova Software")).toBeCloseTo(1 / 2);
  });

  it("returns 0 when none of the query's meaningful tokens appear in the text", () => {
    expect(lexicalOverlapScore("recipe for chocolate lava cake dessert", "Supplier: CloudNova Software")).toBe(0);
  });

  it("returns 0 when the query has no scorable tokens (only stopwords/short words)", () => {
    expect(lexicalOverlapScore("the of a", "Supplier: CloudNova Software")).toBe(0);
  });

  it("ignores stopwords when computing token overlap", () => {
    expect(lexicalOverlapScore("show me the CloudNova invoice", "Supplier: CloudNova Software")).toBe(1);
  });
});

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

  it("matches a plural query token against a singular occurrence in the text", () => {
    // Reproduces the reported bug: "keyboards" (query) didn't match "Keyboard x10"
    // (chunk text) via plain substring inclusion, silently zeroing the boost.
    expect(lexicalOverlapScore("laptops and keyboards", "Logitech Keyboard x10, qty 10")).toBeCloseTo(1 / 2);
  });

  it("still matches a singular query token against a plural occurrence in the text", () => {
    // This direction never needed the plural-stripping fallback: a regular plural
    // always already contains its singular as a substring ("keyboards" contains
    // "keyboard"), so plain substring inclusion handles it on its own.
    expect(lexicalOverlapScore("find the keyboard", "Logitech Keyboards x10, qty 10")).toBe(1);
  });

  it("does not treat unrelated words that happen to end in s as a match", () => {
    expect(lexicalOverlapScore("status of the shipment", "Supplier: CloudNova Software")).toBe(0);
  });

  it("does not boost on a bare 4-digit year shared across unrelated invoices", () => {
    // Reproduces the reported bug: a query mentioning "2026" matched almost every
    // invoice's header/notes chunk in this corpus purely because they all share that
    // year in their invoice numbers, flattening the ranking. The year alone shouldn't
    // count as a relevance signal — date scoping is extractDateRangeFromQuery's job.
    expect(lexicalOverlapScore("what was billed in 2026", "Invoice Number: CNS-2026-501")).toBe(0);
  });

  it("still scores a real match when the query has a year plus a genuine keyword", () => {
    expect(lexicalOverlapScore("CloudNova invoice 2026", "Supplier: CloudNova Software")).toBe(1);
  });
});

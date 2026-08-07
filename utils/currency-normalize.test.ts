import { describe, expect, it } from "vitest";
import { normalizeCurrency } from "@/utils/currency-normalize";

describe("normalizeCurrency", () => {
  it("maps the $ symbol to USD", () => {
    expect(normalizeCurrency("$")).toBe("USD");
  });

  it("keeps USD as USD", () => {
    expect(normalizeCurrency("USD")).toBe("USD");
  });

  it("maps Rs. and Rs to INR", () => {
    expect(normalizeCurrency("Rs.")).toBe("INR");
    expect(normalizeCurrency("Rs")).toBe("INR");
  });

  it("keeps INR as INR", () => {
    expect(normalizeCurrency("INR")).toBe("INR");
  });

  it("maps the rupee symbol to INR", () => {
    expect(normalizeCurrency("₹")).toBe("INR");
  });

  it("returns null for missing or blank input", () => {
    expect(normalizeCurrency(null)).toBeNull();
    expect(normalizeCurrency(undefined)).toBeNull();
    expect(normalizeCurrency("  ")).toBeNull();
  });

  it("passes through an unrecognized code trimmed and uppercased", () => {
    expect(normalizeCurrency(" aed ")).toBe("AED");
  });
});

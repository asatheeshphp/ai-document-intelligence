import { describe, it, expect } from "vitest";
import { summarizeByCurrency } from "@/utils/currency-aggregate";

describe("summarizeByCurrency", () => {
  it("sums all rows when every row shares one currency", () => {
    const result = summarizeByCurrency([
      { currency: "INR", amount: 100 },
      { currency: "INR", amount: 250 },
    ]);

    expect(result).toEqual({ amount: 350, currency: "INR", includedCount: 2, excludedCount: 0 });
  });

  it("picks the currency with the most contributing rows as dominant", () => {
    const result = summarizeByCurrency([
      { currency: "INR", amount: 100 },
      { currency: "INR", amount: 200 },
      { currency: "USD", amount: 5000 },
    ]);

    expect(result.currency).toBe("INR");
    expect(result.amount).toBe(300);
    expect(result.includedCount).toBe(2);
    expect(result.excludedCount).toBe(1);
  });

  it("breaks a row-count tie by picking the larger total", () => {
    const result = summarizeByCurrency([
      { currency: "INR", amount: 100 },
      { currency: "USD", amount: 5000 },
    ]);

    expect(result.currency).toBe("USD");
    expect(result.amount).toBe(5000);
  });

  it("treats a null currency as its own group", () => {
    const result = summarizeByCurrency([
      { currency: null, amount: 10 },
      { currency: null, amount: 20 },
      { currency: "INR", amount: 999 },
    ]);

    expect(result.currency).toBeNull();
    expect(result.amount).toBe(30);
    expect(result.excludedCount).toBe(1);
  });

  it("returns a zeroed-out summary for an empty row list", () => {
    const result = summarizeByCurrency([]);

    expect(result).toEqual({ amount: 0, currency: null, includedCount: 0, excludedCount: 0 });
  });
});

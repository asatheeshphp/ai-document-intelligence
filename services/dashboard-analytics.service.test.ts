import { describe, it, expect } from "vitest";
import {
  buildMonthlyTrend,
  buildVendorComparison,
  buildChargeDistribution,
  buildServiceCostAnalysis,
  buildTopRecurringExpenses,
  type DashboardInvoiceRow,
} from "@/services/dashboard-analytics.service";

function row(overrides: Partial<DashboardInvoiceRow> = {}): DashboardInvoiceRow {
  return {
    invoiceId: "inv-1",
    vendorName: "Vendor Co",
    currency: "INR",
    totalAmount: 100,
    subtotal: 90,
    taxAmount: 10,
    discount: 0,
    shippingCharge: 0,
    invoiceDate: new Date("2026-06-15T00:00:00Z"),
    lineItems: [],
    ...overrides,
  };
}

describe("buildMonthlyTrend", () => {
  it("sums totalAmount per calendar month within the trailing window", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [
      row({ invoiceDate: new Date("2026-06-01T00:00:00Z"), totalAmount: 100 }),
      row({ invoiceDate: new Date("2026-06-20T00:00:00Z"), totalAmount: 50 }),
      row({ invoiceDate: new Date("2026-07-01T00:00:00Z"), totalAmount: 200 }),
    ];

    const result = buildMonthlyTrend(rows, 2, now);

    expect(result).toEqual([
      { label: "Jun 2026", amount: 150, currency: "INR", excludedCount: 0 },
      { label: "Jul 2026", amount: 200, currency: "INR", excludedCount: 0 },
    ]);
  });

  it("includes a zero-amount point for a month with no invoices", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const result = buildMonthlyTrend([], 2, now);

    expect(result).toEqual([
      { label: "Jun 2026", amount: 0, currency: null, excludedCount: 0 },
      { label: "Jul 2026", amount: 0, currency: null, excludedCount: 0 },
    ]);
  });

  it("excludes invoices with no date or no amount", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [
      row({ invoiceDate: null, totalAmount: 999 }),
      row({ invoiceDate: new Date("2026-07-01T00:00:00Z"), totalAmount: null }),
    ];

    const result = buildMonthlyTrend(rows, 1, now);

    expect(result).toEqual([{ label: "Jul 2026", amount: 0, currency: null, excludedCount: 0 }]);
  });

  it("ignores invoices outside the trailing window", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [row({ invoiceDate: new Date("2025-01-01T00:00:00Z"), totalAmount: 500 })];

    const result = buildMonthlyTrend(rows, 1, now);

    expect(result).toEqual([{ label: "Jul 2026", amount: 0, currency: null, excludedCount: 0 }]);
  });
});

describe("buildVendorComparison", () => {
  it("sums totalAmount per vendor and sorts descending", () => {
    const rows = [
      row({ vendorName: "Vendor A", totalAmount: 100 }),
      row({ vendorName: "Vendor B", totalAmount: 500 }),
      row({ vendorName: "Vendor A", totalAmount: 50 }),
    ];

    const result = buildVendorComparison(rows, 8);

    expect(result).toEqual([
      { vendorName: "Vendor B", amount: 500, currency: "INR", excludedCount: 0 },
      { vendorName: "Vendor A", amount: 150, currency: "INR", excludedCount: 0 },
    ]);
  });

  it("caps results to topN", () => {
    const rows = [
      row({ vendorName: "A", totalAmount: 300 }),
      row({ vendorName: "B", totalAmount: 200 }),
      row({ vendorName: "C", totalAmount: 100 }),
    ];

    const result = buildVendorComparison(rows, 2);

    expect(result.map((entry) => entry.vendorName)).toEqual(["A", "B"]);
  });

  it("skips invoices with no vendor name or no amount", () => {
    const rows = [row({ vendorName: null, totalAmount: 999 }), row({ vendorName: "A", totalAmount: null })];

    const result = buildVendorComparison(rows, 8);

    expect(result).toEqual([]);
  });
});

describe("buildChargeDistribution", () => {
  it("sums subtotal, tax, discount, and shipping across invoices in the dominant currency", () => {
    const rows = [
      row({ currency: "INR", subtotal: 100, taxAmount: 10, discount: 5, shippingCharge: 2 }),
      row({ currency: "INR", subtotal: 200, taxAmount: 20, discount: 0, shippingCharge: 8 }),
    ];

    const result = buildChargeDistribution(rows);

    expect(result).toEqual({ subtotal: 300, tax: 30, discount: 5, shipping: 10, currency: "INR", excludedCount: 0 });
  });

  it("excludes invoices in a non-dominant currency from the totals", () => {
    const rows = [
      row({ currency: "INR", totalAmount: 100, subtotal: 90, taxAmount: 10 }),
      row({ currency: "INR", totalAmount: 200, subtotal: 180, taxAmount: 20 }),
      row({ currency: "USD", totalAmount: 5000, subtotal: 4500, taxAmount: 500 }),
    ];

    const result = buildChargeDistribution(rows);

    expect(result.currency).toBe("INR");
    expect(result.subtotal).toBe(270);
    expect(result.excludedCount).toBe(1);
  });

  it("treats missing discount/shipping fields as zero", () => {
    const rows = [row({ discount: null, shippingCharge: null })];

    const result = buildChargeDistribution(rows);

    expect(result.discount).toBe(0);
    expect(result.shipping).toBe(0);
  });
});

describe("buildServiceCostAnalysis and buildTopRecurringExpenses", () => {
  it("groups line items by normalized description and sums amounts", () => {
    const rows = [
      row({ invoiceId: "inv-1", lineItems: [{ description: "Internet Service", amount: 500 }] }),
      row({ invoiceId: "inv-2", lineItems: [{ description: "  internet service  ", amount: 300 }] }),
      row({ invoiceId: "inv-3", lineItems: [{ description: "Office Chair", amount: 1000 }] }),
    ];

    const result = buildServiceCostAnalysis(rows, 8);

    expect(result).toEqual(
      expect.arrayContaining([
        { description: "Office Chair", amount: 1000, currency: "INR", invoiceCount: 1, excludedCount: 0 },
        { description: "Internet Service", amount: 800, currency: "INR", invoiceCount: 2, excludedCount: 0 },
      ])
    );
    expect(result[0].description).toBe("Office Chair");
  });

  it("caps service cost analysis to topN", () => {
    const rows = [
      row({ invoiceId: "inv-1", lineItems: [{ description: "A", amount: 300 }] }),
      row({ invoiceId: "inv-2", lineItems: [{ description: "B", amount: 200 }] }),
      row({ invoiceId: "inv-3", lineItems: [{ description: "C", amount: 100 }] }),
    ];

    const result = buildServiceCostAnalysis(rows, 2);

    expect(result.map((entry) => entry.description)).toEqual(["A", "B"]);
  });

  it("only includes descriptions appearing in 2+ invoices as recurring", () => {
    const rows = [
      row({ invoiceId: "inv-1", lineItems: [{ description: "Internet Service", amount: 500 }] }),
      row({ invoiceId: "inv-2", lineItems: [{ description: "Internet Service", amount: 500 }] }),
      row({ invoiceId: "inv-3", lineItems: [{ description: "One-off Repair", amount: 9000 }] }),
    ];

    const result = buildTopRecurringExpenses(rows, 8);

    expect(result).toEqual([{ description: "Internet Service", amount: 1000, currency: "INR", invoiceCount: 2, excludedCount: 0 }]);
  });

  it("counts a description once per invoice even if repeated within the same invoice", () => {
    const rows = [
      row({
        invoiceId: "inv-1",
        lineItems: [
          { description: "Widget", amount: 10 },
          { description: "Widget", amount: 20 },
        ],
      }),
    ];

    const result = buildServiceCostAnalysis(rows, 8);

    expect(result).toEqual([{ description: "Widget", amount: 30, currency: "INR", invoiceCount: 1, excludedCount: 0 }]);
  });
});

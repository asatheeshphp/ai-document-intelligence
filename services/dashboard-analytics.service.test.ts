import { describe, it, expect, vi } from "vitest";
import {
  buildMonthlyTrend,
  buildVendorComparison,
  buildChargeDistribution,
  buildServiceCostAnalysis,
  buildTopRecurringExpenses,
  DashboardAnalyticsService,
  type DashboardInvoiceRow,
} from "@/services/dashboard-analytics.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { InvoiceStatusQueryService } from "@/services/invoice-status-query.service";

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
    paymentStatus: "PENDING",
    lineItems: [],
    ...overrides,
  };
}

describe("buildMonthlyTrend", () => {
  it("sums totalAmount per calendar month, split into paid and unpaid", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [
      row({ invoiceDate: new Date("2026-06-01T00:00:00Z"), totalAmount: 100, paymentStatus: "PAID" }),
      row({ invoiceDate: new Date("2026-06-20T00:00:00Z"), totalAmount: 50, paymentStatus: "PENDING" }),
      row({ invoiceDate: new Date("2026-07-01T00:00:00Z"), totalAmount: 200, paymentStatus: "PAID" }),
    ];

    const result = buildMonthlyTrend(rows, 2, now);

    expect(result).toEqual([
      {
        currency: "INR",
        points: [
          { label: "Jun 2026", paid: 100, unpaid: 50 },
          { label: "Jul 2026", paid: 200, unpaid: 0 },
        ],
      },
    ]);
  });

  it("splits into one series per currency instead of mixing them into one bar", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [
      row({ invoiceDate: new Date("2026-06-01T00:00:00Z"), totalAmount: 100, currency: "INR" }),
      row({ invoiceDate: new Date("2026-07-01T00:00:00Z"), totalAmount: 50, currency: "USD" }),
    ];

    const result = buildMonthlyTrend(rows, 2, now);

    expect(result).toEqual([
      {
        currency: "INR",
        points: [
          { label: "Jun 2026", paid: 0, unpaid: 100 },
          { label: "Jul 2026", paid: 0, unpaid: 0 },
        ],
      },
      {
        currency: "USD",
        points: [
          { label: "Jun 2026", paid: 0, unpaid: 0 },
          { label: "Jul 2026", paid: 0, unpaid: 50 },
        ],
      },
    ]);
  });

  it("returns no series when there is no data at all", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    expect(buildMonthlyTrend([], 2, now)).toEqual([]);
  });

  it("excludes invoices with no date or no amount", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [
      row({ invoiceDate: null, totalAmount: 999 }),
      row({ invoiceDate: new Date("2026-07-01T00:00:00Z"), totalAmount: null }),
    ];

    const result = buildMonthlyTrend(rows, 1, now);

    expect(result).toEqual([]);
  });

  it("ignores invoices outside the trailing window", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [row({ invoiceDate: new Date("2025-01-01T00:00:00Z"), totalAmount: 500 })];

    const result = buildMonthlyTrend(rows, 1, now);

    expect(result).toEqual([]);
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
      { vendorName: "Vendor B", paid: 0, unpaid: 500, currency: "INR", excludedCount: 0 },
      { vendorName: "Vendor A", paid: 0, unpaid: 150, currency: "INR", excludedCount: 0 },
    ]);
  });

  it("splits each vendor's total into paid and unpaid", () => {
    const rows = [
      row({ vendorName: "Vendor A", totalAmount: 100, paymentStatus: "PAID" }),
      row({ vendorName: "Vendor A", totalAmount: 50, paymentStatus: "PENDING" }),
    ];

    const result = buildVendorComparison(rows, 8);

    expect(result).toEqual([{ vendorName: "Vendor A", paid: 100, unpaid: 50, currency: "INR", excludedCount: 0 }]);
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

describe("DashboardAnalyticsService.getBusinessDashboardData", () => {
  function fakeRepository(rows: DashboardInvoiceRow[]): ProcessingRepository {
    return { listInvoicesForDashboard: vi.fn().mockResolvedValue(rows) } as unknown as ProcessingRepository;
  }

  function fakeStatusService(overdue: unknown[], dueSoon: unknown[]): InvoiceStatusQueryService {
    return {
      listByStatus: vi.fn().mockImplementation((status: string) => Promise.resolve(status === "OVERDUE" ? overdue : dueSoon)),
    } as unknown as InvoiceStatusQueryService;
  }

  it("computes total invoices YTD and overdue/due-soon counts", async () => {
    const now = new Date("2026-07-30T00:00:00Z");
    const rows = [
      row({ invoiceId: "a", invoiceDate: new Date("2026-01-15T00:00:00Z"), totalAmount: 100 }),
      row({ invoiceId: "b", invoiceDate: new Date("2025-12-01T00:00:00Z"), totalAmount: 900 }),
    ];
    const overdue = [{ totalAmount: 50, currency: "INR" }];
    const dueSoon = [{ totalAmount: 75, currency: "INR" }];

    const service = new DashboardAnalyticsService(fakeRepository(rows), fakeStatusService(overdue, dueSoon));
    const result = await service.getBusinessDashboardData(now);

    expect(result.kpi).toEqual({ totalInvoices: 1, overdueCount: 1, dueSoonCount: 1 });
  });

  it("includes all six widget payloads in the result", async () => {
    const service = new DashboardAnalyticsService(fakeRepository([]), fakeStatusService([], []));
    const result = await service.getBusinessDashboardData(new Date("2026-07-30T00:00:00Z"));

    expect(result).toHaveProperty("kpi");
    expect(result).toHaveProperty("monthlyTrend");
    expect(result).toHaveProperty("vendorComparison");
    expect(result).toHaveProperty("chargeDistribution");
    expect(result).toHaveProperty("serviceCostAnalysis");
    expect(result).toHaveProperty("topRecurringExpenses");
  });

  it("requests OVERDUE and UPCOMING-10-day status filters", async () => {
    const statusService = fakeStatusService([], []);
    const service = new DashboardAnalyticsService(fakeRepository([]), statusService);

    await service.getBusinessDashboardData(new Date("2026-07-30T00:00:00Z"));

    expect(statusService.listByStatus).toHaveBeenCalledWith("OVERDUE");
    expect(statusService.listByStatus).toHaveBeenCalledWith("UPCOMING", 10);
  });
});

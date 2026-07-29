import { describe, it, expect, vi } from "vitest";
import { SpendQueryService } from "@/services/spend-query.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";

function fakeRepository(overrides: Record<string, unknown> = {}): ProcessingRepository {
  return {
    getVendorSpendSummary: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as ProcessingRepository;
}

describe("SpendQueryService.getVendorSpendSummary", () => {
  it("passes the vendor pattern through unchanged and parses date strings to Date objects", async () => {
    const getVendorSpendSummary = vi.fn().mockResolvedValue({
      vendorNames: ["Readylink Internet Services Limited"],
      invoiceCount: 3,
      totalAmount: 1767,
      currencies: ["Rs."],
    });
    const repository = fakeRepository({ getVendorSpendSummary });
    const service = new SpendQueryService(repository);

    const result = await service.getVendorSpendSummary({
      vendorNamePattern: "Readylink",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });

    expect(result).toEqual({
      vendorNames: ["Readylink Internet Services Limited"],
      invoiceCount: 3,
      totalAmount: 1767,
      currencies: ["Rs."],
    });

    const [call] = getVendorSpendSummary.mock.calls[0];
    expect(call.vendorNamePattern).toBe("Readylink");
    expect(call.dateFrom.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // Inclusive of the whole end day, not just midnight.
    expect(call.dateTo.toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("passes undefined dates through when no date range is given", async () => {
    const getVendorSpendSummary = vi.fn().mockResolvedValue(null);
    const repository = fakeRepository({ getVendorSpendSummary });
    const service = new SpendQueryService(repository);

    await service.getVendorSpendSummary({ vendorNamePattern: "SuperStore" });

    const [call] = getVendorSpendSummary.mock.calls[0];
    expect(call.dateFrom).toBeUndefined();
    expect(call.dateTo).toBeUndefined();
  });

  it("returns null when the repository finds no match", async () => {
    const repository = fakeRepository({ getVendorSpendSummary: vi.fn().mockResolvedValue(null) });
    const service = new SpendQueryService(repository);

    const result = await service.getVendorSpendSummary({ vendorNamePattern: "NoSuchVendor" });

    expect(result).toBeNull();
  });
});

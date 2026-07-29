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
    // Single-word pattern with no spaces to strip -- still passes through as an
    // equivalent regex (each character joined by an optional "\s*"), which still
    // matches "Readylink" literally.
    expect(new RegExp(call.vendorNamePattern, "i").test("Readylink Internet Services Limited")).toBe(true);
    expect(call.dateFrom.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // Inclusive of the whole end day, not just midnight.
    expect(call.dateTo.toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("builds a whitespace-tolerant pattern so a space-dropped vendor name still matches", async () => {
    // Confirmed live: the model sometimes extracts "ExpressCargo" instead of
    // "Express Cargo", even with an explicit prompt instruction not to.
    const getVendorSpendSummary = vi.fn().mockResolvedValue(null);
    const repository = fakeRepository({ getVendorSpendSummary });
    const service = new SpendQueryService(repository);

    await service.getVendorSpendSummary({ vendorNamePattern: "ExpressCargo" });

    const [call] = getVendorSpendSummary.mock.calls[0];
    const pattern = new RegExp(call.vendorNamePattern, "i");
    expect(pattern.test("Express Cargo & Logistics Solutions")).toBe(true);
    expect(pattern.test("ExpressCargo")).toBe(true);
    expect(pattern.test("Totally Unrelated Vendor")).toBe(false);
  });

  it("produces the same pattern whether or not the extracted vendor name kept its spaces", async () => {
    const getVendorSpendSummary = vi.fn().mockResolvedValue(null);
    const repository = fakeRepository({ getVendorSpendSummary });
    const service = new SpendQueryService(repository);

    await service.getVendorSpendSummary({ vendorNamePattern: "Express Cargo" });
    const withSpaces = getVendorSpendSummary.mock.calls[0][0].vendorNamePattern;

    getVendorSpendSummary.mockClear();
    await service.getVendorSpendSummary({ vendorNamePattern: "ExpressCargo" });
    const withoutSpaces = getVendorSpendSummary.mock.calls[0][0].vendorNamePattern;

    expect(withSpaces).toBe(withoutSpaces);
  });

  it("escapes regex special characters in the vendor name", async () => {
    const getVendorSpendSummary = vi.fn().mockResolvedValue(null);
    const repository = fakeRepository({ getVendorSpendSummary });
    const service = new SpendQueryService(repository);

    await service.getVendorSpendSummary({ vendorNamePattern: "ABC Technologies Pvt. Ltd." });

    const [call] = getVendorSpendSummary.mock.calls[0];
    const pattern = new RegExp(call.vendorNamePattern, "i");
    expect(pattern.test("ABC Technologies Pvt. Ltd.")).toBe(true);
    // A literal "." must not accidentally match any-character in a way that makes this
    // pass for unrelated text -- confirms the dot was escaped, not left as regex "any char".
    expect(pattern.test("ABC TechnologiesXPvtXLtdX")).toBe(false);
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

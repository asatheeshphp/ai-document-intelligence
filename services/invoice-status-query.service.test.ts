import { describe, it, expect, vi } from "vitest";
import { InvoiceStatusQueryService } from "@/services/invoice-status-query.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";

function fakeRepository(overrides: Record<string, unknown> = {}): ProcessingRepository {
  return { listInvoices: vi.fn().mockResolvedValue([]), ...overrides } as unknown as ProcessingRepository;
}

describe("InvoiceStatusQueryService.listByStatus", () => {
  it("queries UNPAID as not-PAID, matching due/route.ts's own filter for legacy rows with no stored status", async () => {
    const listInvoices = vi.fn().mockResolvedValue([]);
    const repository = fakeRepository({ listInvoices });
    const service = new InvoiceStatusQueryService(repository);

    await service.listByStatus("UNPAID");

    expect(listInvoices).toHaveBeenCalledWith({ paymentStatus: { $ne: "PAID" } });
  });

  it("queries PAID as an exact match", async () => {
    const listInvoices = vi.fn().mockResolvedValue([]);
    const repository = fakeRepository({ listInvoices });
    const service = new InvoiceStatusQueryService(repository);

    await service.listByStatus("PAID");

    expect(listInvoices).toHaveBeenCalledWith({ paymentStatus: "PAID" });
  });

  it("queries OVERDUE as not-PAID with a past due date", async () => {
    const listInvoices = vi.fn().mockResolvedValue([]);
    const repository = fakeRepository({ listInvoices });
    const service = new InvoiceStatusQueryService(repository);

    await service.listByStatus("OVERDUE");

    const [filter] = listInvoices.mock.calls[0];
    expect(filter.paymentStatus).toEqual({ $ne: "PAID" });
    expect(filter.dueDate.$ne).toBeNull();
    expect(filter.dueDate.$lt).toBeInstanceOf(Date);
  });

  it("maps matched invoices to summary items", async () => {
    const dueDate = new Date("2026-08-01T00:00:00.000Z");
    const listInvoices = vi.fn().mockResolvedValue([
      {
        invoiceNumber: "INV-1",
        vendorName: "Vendor Co",
        totalAmount: 500,
        currency: "USD",
        dueDate,
      },
    ]);
    const repository = fakeRepository({ listInvoices });
    const service = new InvoiceStatusQueryService(repository);

    const result = await service.listByStatus("UNPAID");

    expect(result).toEqual([
      { invoiceNumber: "INV-1", vendorName: "Vendor Co", totalAmount: 500, currency: "USD", dueDate },
    ]);
  });
});

describe("InvoiceStatusQueryService.getStatusForInvoiceNumber", () => {
  it("queries by exact invoice number, case-insensitively", async () => {
    const listInvoices = vi.fn().mockResolvedValue([]);
    const repository = fakeRepository({ listInvoices });
    const service = new InvoiceStatusQueryService(repository);

    await service.getStatusForInvoiceNumber("EXL-2026-2048");

    const [filter] = listInvoices.mock.calls[0];
    const pattern = new RegExp(filter.invoiceNumber.$regex, filter.invoiceNumber.$options);
    expect(pattern.test("EXL-2026-2048")).toBe(true);
    expect(pattern.test("exl-2026-2048")).toBe(true);
    expect(pattern.test("EXL-2026-20489")).toBe(false);
  });

  it("reports the invoice's real PENDING status and overdue-ness, regardless of any guessed status", async () => {
    // Reproduces the confirmed live bug: "what is the payment status of invoice
    // EXL-2026-2048?" previously ran the same blanket "list every PAID invoice" query
    // as "any paid invoices?", discarding the invoice number entirely. This reports the
    // REAL current status directly.
    const listInvoices = vi.fn().mockResolvedValue([
      {
        invoiceNumber: "EXL-2026-2048",
        vendorName: "Express Cargo & Logistics Solutions",
        totalAmount: 45810,
        currency: null,
        paymentStatus: "PENDING",
        dueDate: new Date("2026-07-22T00:00:00.000Z"),
      },
    ]);
    const repository = fakeRepository({ listInvoices });
    const service = new InvoiceStatusQueryService(repository);

    const result = await service.getStatusForInvoiceNumber("EXL-2026-2048");

    expect(result).toHaveLength(1);
    expect(result[0].paymentStatus).toBe("PENDING");
    // "now" in this test environment is well past 2026-07-22.
    expect(result[0].isOverdue).toBe(true);
  });

  it("reports PAID and never overdue for an invoice marked PAID even with a past due date", async () => {
    const listInvoices = vi.fn().mockResolvedValue([
      {
        invoiceNumber: "INV-1",
        vendorName: "Vendor Co",
        paymentStatus: "PAID",
        dueDate: new Date("2020-01-01T00:00:00.000Z"),
      },
    ]);
    const repository = fakeRepository({ listInvoices });
    const service = new InvoiceStatusQueryService(repository);

    const result = await service.getStatusForInvoiceNumber("INV-1");

    expect(result[0].paymentStatus).toBe("PAID");
    expect(result[0].isOverdue).toBe(false);
  });

  it("returns an empty array when the invoice number doesn't match anything", async () => {
    const repository = fakeRepository({ listInvoices: vi.fn().mockResolvedValue([]) });
    const service = new InvoiceStatusQueryService(repository);

    const result = await service.getStatusForInvoiceNumber("NO-SUCH-INVOICE");

    expect(result).toEqual([]);
  });
});

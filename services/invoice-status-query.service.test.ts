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

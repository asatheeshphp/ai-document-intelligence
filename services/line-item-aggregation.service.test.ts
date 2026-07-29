import { describe, it, expect, vi } from "vitest";
import { LineItemAggregationService } from "@/services/line-item-aggregation.service";
import type { SearchService, SearchResultItem } from "@/services/search.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";

function fakeSearchResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    invoiceId: "inv-1",
    documentId: "doc-1",
    chunkType: "line_items",
    chunkText: "Widget, qty 1, unit price 100, amount 100",
    score: 0.9,
    invoice: { invoiceNumber: "INV-1", vendorName: "Vendor Co" },
    ...overrides,
  };
}

function fakeRepository(overrides: Record<string, unknown> = {}): ProcessingRepository {
  return { findInvoicesByIds: vi.fn().mockResolvedValue([]), ...overrides } as unknown as ProcessingRepository;
}

describe("LineItemAggregationService.getLineItemTotal", () => {
  it("sums each matched line item's own extracted amount field, not the model's arithmetic", async () => {
    // Reproduces the confirmed live bug: asked to sum "computer" line items, the model
    // picked a garbled fragment ($1,330.29) and did its own wrong arithmetic on top of
    // it, instead of using the real per-line total (4069.53) already sitting in that
    // same chunk's own "amount" field.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-27639",
        invoice: { invoiceNumber: "27639", vendorName: "SuperStore" },
        chunkText: "Chromcraft Computer Table, with Bottom Storage, qty 3 $1,330.29, unit price 4069.53, amount 4069.53",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const repository = fakeRepository({
      findInvoicesByIds: vi.fn().mockResolvedValue([{ _id: { toString: () => "inv-27639" }, currency: "USD" }]),
    });
    const service = new LineItemAggregationService(searchService, repository);

    const result = await service.getLineItemTotal("computer");

    expect(result).not.toBeNull();
    expect(result?.totalAmount).toBe(4069.53);
    expect(result?.currencies).toEqual(["USD"]);
    expect(result?.items).toHaveLength(1);
  });

  it("sums across multiple matching line items from different invoices", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-a",
        invoice: { invoiceNumber: "A", vendorName: "Vendor A" },
        chunkText: "Laptop, qty 1, unit price 1000, amount 1000",
      }),
      fakeSearchResult({
        invoiceId: "inv-b",
        invoice: { invoiceNumber: "B", vendorName: "Vendor B" },
        chunkText: "Desktop Computer, qty 2, unit price 500, amount 1000",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const repository = fakeRepository({
      findInvoicesByIds: vi.fn().mockResolvedValue([
        { _id: { toString: () => "inv-a" }, currency: "USD" },
        { _id: { toString: () => "inv-b" }, currency: "USD" },
      ]),
    });
    const service = new LineItemAggregationService(searchService, repository);

    const result = await service.getLineItemTotal("computer");

    expect(result?.totalAmount).toBe(2000);
    expect(result?.items).toHaveLength(2);
  });

  it("flags mixed currencies instead of silently summing across them", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-a",
        chunkText: "Laptop, qty 1, unit price 1000, amount 1000",
      }),
      fakeSearchResult({
        invoiceId: "inv-b",
        chunkText: "Desktop, qty 1, unit price 500, amount 500",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const repository = fakeRepository({
      findInvoicesByIds: vi.fn().mockResolvedValue([
        { _id: { toString: () => "inv-a" }, currency: "USD" },
        { _id: { toString: () => "inv-b" }, currency: "INR" },
      ]),
    });
    const service = new LineItemAggregationService(searchService, repository);

    const result = await service.getLineItemTotal("computer");

    expect(result?.currencies.sort()).toEqual(["INR", "USD"]);
  });

  it("ignores a matched chunk with no parseable amount field", async () => {
    const searchResults = [fakeSearchResult({ chunkText: "Miscellaneous notes, no amount here" })];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const repository = fakeRepository();
    const service = new LineItemAggregationService(searchService, repository);

    const result = await service.getLineItemTotal("computer");

    expect(result).toBeNull();
  });

  it("returns null when nothing matches the keyword", async () => {
    const searchService = { search: vi.fn().mockResolvedValue({ results: [] }) } as unknown as SearchService;
    const repository = fakeRepository();
    const service = new LineItemAggregationService(searchService, repository);

    const result = await service.getLineItemTotal("nonexistent-product");

    expect(result).toBeNull();
  });

  it("scopes the search to line-item chunks only", async () => {
    const search = vi.fn().mockResolvedValue({ results: [] });
    const searchService = { search } as unknown as SearchService;
    const repository = fakeRepository();
    const service = new LineItemAggregationService(searchService, repository);

    await service.getLineItemTotal("computer");

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "computer", filters: { chunkType: "line_items" } })
    );
  });
});

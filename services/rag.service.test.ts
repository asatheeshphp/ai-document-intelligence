import { describe, it, expect, vi } from "vitest";
import { RagService } from "@/services/rag.service";
import type { SearchService, SearchResultItem } from "@/services/search.service";
import type { OllamaService } from "@/services/ollama.service";
import type { SpendQueryService } from "@/services/spend-query.service";
import type { ChatIntentService } from "@/services/chat-intent.service";

function fakeSearchResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    invoiceId: "inv-1",
    documentId: "doc-1",
    chunkText: "some chunk text",
    score: 0.9,
    invoice: { invoiceNumber: "INV-1", vendorName: "Vendor Co" },
    ...overrides,
  };
}

function fakeChatIntentService(intent: Record<string, unknown>): ChatIntentService {
  return { detectIntent: vi.fn().mockResolvedValue(intent) } as unknown as ChatIntentService;
}

describe("RagService.answer — aggregation path", () => {
  it("answers with a computed total when intent detection finds a vendor match", async () => {
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn() } as unknown as OllamaService;
    const spendQueryService = {
      getVendorSpendSummary: vi.fn().mockResolvedValue({
        vendorNames: ["Readylink Internet Services Limited"],
        invoiceCount: 3,
        totalAmount: 1767,
        currencies: ["Rs."],
      }),
    } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({
      type: "AGGREGATION",
      vendor: "Readylink",
      from: "2026-01-01",
      to: "2026-12-31",
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService);
    const result = await service.answer({ question: "How much have I paid Readylink this year?" });

    expect(result.mode).toBe("computed");
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain("Readylink Internet Services Limited");
    expect(result.answer).toContain("Rs. 1767.00");
    expect(result.answer).toContain("3 invoices");
    expect(result.answer).toContain("between 2026-01-01 and 2026-12-31");
    expect(searchService.search).not.toHaveBeenCalled();
  });

  it("flags a mixed-currency total instead of silently presenting one number", async () => {
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const ollamaService = {} as unknown as OllamaService;
    const spendQueryService = {
      getVendorSpendSummary: vi.fn().mockResolvedValue({
        vendorNames: ["SuperStore"],
        invoiceCount: 2,
        totalAmount: 100,
        currencies: ["USD", "Rs."],
      }),
    } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "AGGREGATION", vendor: "SuperStore" });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService);
    const result = await service.answer({ question: "What's my total spend with SuperStore?" });

    expect(result.mode).toBe("computed");
    expect(result.answer).toMatch(/different currencies/);
  });

  it("falls through to retrieval when no vendor matched the aggregation query", async () => {
    const searchResults = [fakeSearchResult()];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Some retrieved answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn().mockResolvedValue(null) } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "AGGREGATION", vendor: "NoSuchVendor" });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService);
    const result = await service.answer({ question: "How much have I paid NoSuchVendor?" });

    expect(result.mode).toBe("retrieved");
    expect(searchService.search).toHaveBeenCalled();
    expect(result.answer).toBe("Some retrieved answer");
  });
});

describe("RagService.answer — retrieval path (unchanged existing behavior)", () => {
  it("retrieves and synthesizes an answer when intent is RETRIEVAL", async () => {
    const searchResults = [fakeSearchResult()];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService);
    const result = await service.answer({ question: "Which invoices mention GST?" });

    expect(result.mode).toBe("retrieved");
    expect(result.answer).toBe("Synthesized answer");
    expect(result.sources).toEqual(searchResults);
    expect(spendQueryService.getVendorSpendSummary).not.toHaveBeenCalled();
  });

  it("returns the no-context answer when retrieval finds nothing", async () => {
    const searchService = { search: vi.fn().mockResolvedValue({ results: [] }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn() } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService);
    const result = await service.answer({ question: "Anything about unicorns?" });

    expect(result.mode).toBe("retrieved");
    expect(result.sources).toEqual([]);
    expect(ollamaService.chatCompletion).not.toHaveBeenCalled();
  });

  it("falls through to retrieval when intent detection itself fails (network error)", async () => {
    const searchResults = [fakeSearchResult()];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = {
      detectIntent: vi.fn().mockRejectedValue(new Error("network error")),
    } as unknown as ChatIntentService;

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService);
    const result = await service.answer({ question: "Which invoices mention GST?" });

    expect(result.mode).toBe("retrieved");
    expect(result.answer).toBe("Synthesized answer");
    expect(spendQueryService.getVendorSpendSummary).not.toHaveBeenCalled();
  });
});

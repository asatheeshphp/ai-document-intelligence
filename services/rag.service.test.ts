import { describe, it, expect, vi } from "vitest";
import { RagService } from "@/services/rag.service";
import type { SearchService, SearchResultItem } from "@/services/search.service";
import type { OllamaService } from "@/services/ollama.service";
import type { SpendQueryService } from "@/services/spend-query.service";
import type { ChatIntentService } from "@/services/chat-intent.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { InvoiceStatusQueryService } from "@/services/invoice-status-query.service";

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

function fakeRepository(overrides: Record<string, unknown> = {}): ProcessingRepository {
  return { findChunksByInvoiceId: vi.fn().mockResolvedValue([]), ...overrides } as unknown as ProcessingRepository;
}

function fakeInvoiceStatusQueryService(overrides: Record<string, unknown> = {}): InvoiceStatusQueryService {
  return { listByStatus: vi.fn().mockResolvedValue([]), ...overrides } as unknown as InvoiceStatusQueryService;
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

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository()
    );
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

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository()
    );
    const result = await service.answer({ question: "What's my total spend with SuperStore?" });

    expect(result.mode).toBe("computed");
    expect(result.answer).toMatch(/different currencies/);
  });

  it("falls through to retrieval when no vendor matched the aggregation query", async () => {
    const searchResults = [fakeSearchResult({ chunkText: "unrelated text" })];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Some retrieved answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn().mockResolvedValue(null) } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "AGGREGATION", vendor: "NoSuchVendor" });

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository()
    );
    const result = await service.answer({ question: "How much have I paid NoSuchVendor?" });

    expect(result.mode).toBe("retrieved");
    expect(searchService.search).toHaveBeenCalled();
    expect(result.answer).toBe("Some retrieved answer");
  });
});

describe("RagService.answer — retrieval path (unchanged existing behavior)", () => {
  it("retrieves and synthesizes an answer when intent is RETRIEVAL", async () => {
    const searchResults = [fakeSearchResult({ chunkText: "unrelated text, no numbers" })];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository()
    );
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

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository()
    );
    const result = await service.answer({ question: "Anything about unicorns?" });

    expect(result.mode).toBe("retrieved");
    expect(result.sources).toEqual([]);
    expect(ollamaService.chatCompletion).not.toHaveBeenCalled();
  });

  it("falls through to retrieval when intent detection itself fails (network error)", async () => {
    const searchResults = [fakeSearchResult({ chunkText: "unrelated text, no numbers" })];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = {
      detectIntent: vi.fn().mockRejectedValue(new Error("network error")),
    } as unknown as ChatIntentService;

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository()
    );
    const result = await service.answer({ question: "Which invoices mention GST?" });

    expect(result.mode).toBe("retrieved");
    expect(result.answer).toBe("Synthesized answer");
    expect(spendQueryService.getVendorSpendSummary).not.toHaveBeenCalled();
  });
});

describe("RagService.answer — payment-chunk augmentation", () => {
  it("adds an invoice's payment chunk to the context and sources when search didn't already retrieve one", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        chunkType: "header",
        chunkText: "Supplier: Vendor Co",
        invoice: { invoiceNumber: "INV-1", vendorName: "Vendor Co" },
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: Vendor Co", _id: { toString: () => "chunk-header" } },
        { chunkType: "payment", text: "Grand Total: 500.00", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "What did Vendor Co bill?" });

    expect(result.sources).toHaveLength(2);
    expect(result.sources.some((s) => s.chunkType === "payment" && s.chunkText.includes("500.00"))).toBe(true);

    const promptSentToModel = (ollamaService.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(promptSentToModel).toContain("Grand Total: 500.00");
  });

  it("does not add a payment chunk if one was already retrieved", async () => {
    const searchResults = [
      fakeSearchResult({ invoiceId: "inv-1", chunkType: "payment", chunkText: "Grand Total: 500.00" }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const findChunksByInvoiceId = vi.fn();
    const repository = fakeRepository({ findChunksByInvoiceId });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "What did Vendor Co bill?" });

    expect(result.sources).toHaveLength(1);
    expect(findChunksByInvoiceId).not.toHaveBeenCalled();
  });
});

describe("RagService.answer — grounding verification", () => {
  it("replaces an answer with a safe fallback when it states a number not present in the invoice it names", async () => {
    // Mirrors the confirmed live bug: the model cited "Vendor Co" but stated a number
    // that was only ever seen in a different, unrelated invoice's chunk.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-1", vendorName: "Vendor Co" },
        chunkText: "Supplier: Vendor Co",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("Vendor Co's invoice total is 4148.20."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      // Vendor Co's own chunks never mention 4148.20 anywhere.
      findChunksByInvoiceId: vi.fn().mockResolvedValue([{ chunkType: "header", text: "Supplier: Vendor Co" }]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "How much did Vendor Co bill?" });

    expect(result.answer).not.toContain("4148.20");
    expect(result.answer).toMatch(/couldn't confirm an exact figure/);
  });

  it("keeps the answer when the stated number does appear in the named invoice's own chunks", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-1", vendorName: "Vendor Co" },
        chunkText: "Supplier: Vendor Co",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("Vendor Co's invoice total is 500.00."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: Vendor Co" },
        { chunkType: "payment", text: "Grand Total: 500.00", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "How much did Vendor Co bill?" });

    expect(result.answer).toBe("Vendor Co's invoice total is 500.00.");
  });

  it("skips the grounding check for a multi-invoice answer (names zero or more than one invoice)", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-1", vendorName: "Vendor One" },
        chunkText: "Supplier: Vendor One",
      }),
      fakeSearchResult({
        invoiceId: "inv-2",
        invoice: { invoiceNumber: "INV-2", vendorName: "Vendor Two" },
        chunkText: "Supplier: Vendor Two",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue("Vendor One and Vendor Two both have invoices totaling 9999.99 combined."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository();

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "Which invoices are outstanding?" });

    // Neither invoice's own chunks contain "9999.99", but since the answer names TWO
    // invoices, the single-invoice grounding check doesn't apply and the answer passes
    // through unmodified.
    expect(result.answer).toContain("9999.99");
  });

  it("replaces an answer with a safe fallback when the named invoice's own content has nothing to do with the question", async () => {
    // Reproduces the confirmed live bug: "how much paid for internet 2026?" got a
    // confident answer naming a real, unrelated logistics invoice, stating that
    // invoice's own genuine total -- the numeric check alone would have passed this,
    // since the number wasn't misattributed. The premise itself ("this invoice is about
    // internet") is what's wrong, and "internet" never appears anywhere in the invoice.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "EXL-2026-2048", vendorName: "Express Cargo & Logistics Solutions" },
        chunkText: "Supplier: Express Cargo & Logistics Solutions",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue("The total amount paid for internet in 2026 was Express Cargo & Logistics Solutions' 45810."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: Express Cargo & Logistics Solutions" },
        { chunkType: "payment", text: "Grand Total: 45810", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "how much paid for internet 2026?" });

    expect(result.answer).not.toContain("45810");
    expect(result.answer).toMatch(/doesn't appear to mention what you asked about/);
  });

  it("still rejects the mismatch when a filler word in the question happens to be a substring of an unrelated word in the invoice", async () => {
    // Reproduces the second confirmed live bug: "get all internet related invoices" was
    // NOT rejected by the first version of this check, because the filler word "all"
    // scored a false substring match inside "allowance" in one of the invoice's line
    // items -- alone enough to make lexicalOverlapScore's raw fraction nonzero, even
    // though "internet" (the actual subject) never appears anywhere. Word-boundary
    // matching must not count "all" as present just because "allowance" is.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "EXL-2026-2048", vendorName: "Express Cargo & Logistics Solutions" },
        chunkText: "Supplier: Express Cargo & Logistics Solutions",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue(
          "Express Cargo & Logistics Solutions (EXL-2026-2048) is the only invoice related to internet services."
        ),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: Express Cargo & Logistics Solutions" },
        {
          chunkType: "line_items",
          text: "Driver Allowance 2 Days, qty 1, unit price 1000, amount 1000",
        },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "get all internet related invoices" });

    expect(result.answer).toMatch(/doesn't appear to mention what you asked about/);
  });

  it("keeps the answer when the question's key terms do appear in the named invoice's own content", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "EXL-2026-2048", vendorName: "Express Cargo & Logistics Solutions" },
        chunkText: "Supplier: Express Cargo & Logistics Solutions",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("Express Cargo & Logistics Solutions' grand total is 45810."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: Express Cargo & Logistics Solutions" },
        { chunkType: "payment", text: "Grand Total: 45810", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "What is the grand total for Express Cargo?" });

    expect(result.answer).toBe("Express Cargo & Logistics Solutions' grand total is 45810.");
  });

  it("skips the premise check for a non-English question even with zero literal word overlap", async () => {
    // Guards multilingual recall: SearchService's own translation-fallback note
    // documents that a genuine non-English query can correctly match an invoice it
    // shares no literal words with. Rejecting on overlap here would defeat that.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-1", vendorName: "Readylink Internet Services Limited" },
        chunkText: "Supplier: Readylink Internet Services Limited",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("Readylink Internet Services Limited-க்கான தொகை 1767 ரூபாய்."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "payment", text: "Grand Total: 1767.00", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "நான் Readylink க்கு எவ்வளவு பணம் செலுத்தியுள்ளேன்?" });

    // The Tamil question shares no literal tokens with the invoice text, but since it's
    // non-ASCII the premise check is skipped -- only the numeric check applies, and
    // 1767 does appear in the invoice's own chunk, so the answer passes through.
    expect(result.answer).toBe("Readylink Internet Services Limited-க்கான தொகை 1767 ரூபாய்.");
  });
});

describe("RagService.answer — status-filter path", () => {
  it("answers with a computed list when intent detection finds a status filter", async () => {
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn() } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "STATUS_FILTER", status: "UNPAID" });
    const dueDate = new Date("2026-08-01T00:00:00.000Z");
    const invoiceStatusQueryService = fakeInvoiceStatusQueryService({
      listByStatus: vi.fn().mockResolvedValue([
        { invoiceNumber: "INV-1", vendorName: "Vendor Co", totalAmount: 500, currency: "USD", dueDate },
      ]),
    });

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository(),
      invoiceStatusQueryService
    );
    const result = await service.answer({ question: "Any unpaid invoices?" });

    expect(result.mode).toBe("computed");
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain("Found 1 unpaid invoice");
    expect(result.answer).toContain("INV-1");
    expect(result.answer).toContain("Vendor Co");
    expect(result.answer).toContain("USD 500.00");
    expect(result.answer).toContain("2026-08-01");
    expect(searchService.search).not.toHaveBeenCalled();
    expect(invoiceStatusQueryService.listByStatus).toHaveBeenCalledWith("UNPAID");
  });

  it("answers directly with a clear zero-results message rather than falling through to retrieval", async () => {
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn() } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "STATUS_FILTER", status: "OVERDUE" });
    const invoiceStatusQueryService = fakeInvoiceStatusQueryService();

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository(),
      invoiceStatusQueryService
    );
    const result = await service.answer({ question: "Which invoices are overdue?" });

    expect(result.mode).toBe("computed");
    expect(result.answer).toBe("I couldn't find any overdue invoices.");
    expect(searchService.search).not.toHaveBeenCalled();
  });
});

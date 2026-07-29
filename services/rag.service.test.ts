import { describe, it, expect, vi } from "vitest";
import { RagService } from "@/services/rag.service";
import type { SearchService, SearchResultItem } from "@/services/search.service";
import type { OllamaService } from "@/services/ollama.service";
import type { SpendQueryService } from "@/services/spend-query.service";
import type { ChatIntentService } from "@/services/chat-intent.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { InvoiceStatusQueryService } from "@/services/invoice-status-query.service";
import type { LineItemAggregationService } from "@/services/line-item-aggregation.service";

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

function fakeLineItemAggregationService(overrides: Record<string, unknown> = {}): LineItemAggregationService {
  return { getLineItemTotal: vi.fn().mockResolvedValue(null), ...overrides } as unknown as LineItemAggregationService;
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

  it("does not re-fetch chunks when both required chunk types were already retrieved", async () => {
    const searchResults = [
      fakeSearchResult({ invoiceId: "inv-1", chunkType: "payment", chunkText: "Grand Total: 500.00" }),
      fakeSearchResult({ invoiceId: "inv-1", chunkType: "header", chunkText: "Invoice Number: INV-1" }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const findChunksByInvoiceId = vi.fn();
    const repository = fakeRepository({ findChunksByInvoiceId });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "What did Vendor Co bill?" });

    expect(result.sources).toHaveLength(2);
    expect(findChunksByInvoiceId).not.toHaveBeenCalled();
  });

  it("adds the missing header chunk (PO number, due date) even when the payment chunk was already retrieved", async () => {
    // Reproduces the confirmed live bug: asked for ABC Technologies' PO number, the
    // model answered with its own invoice number instead -- not fabricated from
    // nothing, but because the header chunk (the only one containing "PO Number:
    // PO-45879") never made it into context, since a different chunk type won the
    // per-invoice ranking slot.
    const searchResults = [
      fakeSearchResult({ invoiceId: "inv-1", chunkType: "payment", chunkText: "Grand Total: 47200" }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue("Synthesized answer") } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        {
          chunkType: "header",
          text: "Invoice Number: INV-1\nPO Number: PO-45879",
          _id: { toString: () => "chunk-header" },
        },
        { chunkType: "payment", text: "Grand Total: 47200", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "What is the PO number for Vendor Co?" });

    expect(result.sources).toHaveLength(2);
    expect(result.sources.some((s) => s.chunkType === "header" && s.chunkText.includes("PO-45879"))).toBe(true);

    const promptSentToModel = (ollamaService.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(promptSentToModel).toContain("PO-45879");
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
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: Vendor Co", _id: { toString: () => "chunk-header" } },
      ]),
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
        { chunkType: "header", text: "Supplier: Vendor Co", _id: { toString: () => "chunk-header" } },
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
        { chunkType: "header", text: "Supplier: Express Cargo & Logistics Solutions", _id: { toString: () => "chunk-header" } },
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
        { chunkType: "header", text: "Supplier: Express Cargo & Logistics Solutions", _id: { toString: () => "chunk-header" } },
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
        { chunkType: "header", text: "Supplier: Express Cargo & Logistics Solutions", _id: { toString: () => "chunk-header" } },
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

  it("closes the coverage gap: attributes an answer to its invoice by stated numbers when the answer never names it, and catches a genuine premise mismatch", async () => {
    // Reproduces the confirmed live bug: "summarize the total computer invoice related
    // amount" answered with a real invoice's own numbers ($4,069.53 + $78.66 =
    // $4,148.20) without ever writing "SuperStore" or "27639" in the text --
    // mentionsInvoice-based attribution alone found zero named invoices and silently
    // skipped verification, even though the sources conclusively show only one invoice
    // was used. This uses a vocabulary word ("software") that genuinely isn't anywhere
    // in the invoice's own text, to prove the coverage gap itself is closed --
    // separately from the deeper "coincidental literal word match" limitation covered
    // by the next test.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "27639", vendorName: "SuperStore" },
        chunkText: "Subtotal: 4069.53",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue("The total amount for the software invoices is $4,069.53 + $78.66 = $4,148.20."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: SuperStore", _id: { toString: () => "chunk-header" } },
        {
          chunkType: "line_items",
          text: "Chromcraft Table, with Bottom Storage, qty 3 price 4069.53",
        },
        {
          chunkType: "payment",
          text: "Subtotal: 4069.53\nShipping Charge: 78.66\nGrand Total: 4148.2",
          _id: { toString: () => "chunk-payment" },
        },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "summarize the software invoice cost" });

    expect(result.answer).toMatch(/doesn't appear to mention what you asked about/);
  });

  it("documents the remaining known limitation: a coincidental literal word match is not caught even with attribution", async () => {
    // Same live bug as above, but with the invoice's real product name intact
    // ("Chromcraft Computer Table"). "computer" genuinely occurs there as a real word --
    // it's a computer DESK, not a computer -- so the word-boundary premise check
    // correctly finds it present and passes the answer through. Distinguishing "word is
    // lexically present" from "topically relevant" needs real semantic understanding,
    // which this check deliberately doesn't attempt (see rag.service.ts's own comment on
    // attributeInvoiceByNumbers). This test exists so the limitation stays a documented,
    // intentional trade-off rather than a silent gap.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "27639", vendorName: "SuperStore" },
        chunkText: "Subtotal: 4069.53",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const answerText = "The total amount for the computer invoices is $4,069.53 + $78.66 = $4,148.20.";
    const ollamaService = { chatCompletion: vi.fn().mockResolvedValue(answerText) } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: SuperStore", _id: { toString: () => "chunk-header" } },
        {
          chunkType: "line_items",
          text: "Chromcraft Computer Table, with Bottom Storage, qty 3 amount 4069.53",
        },
        {
          chunkType: "payment",
          text: "Subtotal: 4069.53\nShipping Charge: 78.66\nGrand Total: 4148.2",
          _id: { toString: () => "chunk-payment" },
        },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "summarize the total computer invoice related amount" });

    expect(result.answer).toBe(answerText);
  });

  it("does not attribute when the answer's numbers coincidentally fit more than one invoice", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-1", vendorName: "Vendor One" },
        chunkText: "Subtotal: 100",
      }),
      fakeSearchResult({
        invoiceId: "inv-2",
        invoice: { invoiceNumber: "INV-2", vendorName: "Vendor Two" },
        chunkText: "Subtotal: 100",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("The total is 100."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    // Both invoices' own chunks happen to contain "100" -- an ambiguous match, so
    // neither should be trusted as "the" invoice this answer is about.
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "payment", text: "Grand Total: 100", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "what's the total?" });

    expect(result.answer).toBe("The total is 100.");
  });

  it("does not attribute when the answer's numbers match no invoice at all", async () => {
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-1", vendorName: "Vendor Co" },
        chunkText: "Subtotal: 100",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("The total is 999999."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "payment", text: "Grand Total: 100", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "what's the total?" });

    // Documented limitation: with no textual name AND no invoice whose own numbers
    // match, there's nothing to attribute to, so a fully fabricated figure with no
    // vendor/invoice-number attribution to fall back on isn't caught either. Not
    // currently the model's observed failure mode (see attributeInvoiceByNumbers'
    // comment) -- misattribution of a REAL number has been, which this fix does catch.
    expect(result.answer).toBe("The total is 999999.");
  });

  it("rejects a fabricated invoice number even when its attached dollar figure is genuinely correct", async () => {
    // Reproduces the confirmed live bug: "The total logistics amount for Invoice
    // INV-2026-2048 is 45,810 rupees" spliced the letter prefix of one real invoice
    // ("INV-2026-001") onto the numeric suffix of a different real invoice
    // ("EXL-2026-2048") -- a fabricated identifier that matches nothing on file, even
    // though 45,810 genuinely is the real Express Cargo invoice's total. Both the
    // premise check ("logistics" is a real word in that invoice) and the numeric check
    // (45810 is a real number there) would pass this -- it needs its own check.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "EXL-2026-2048", vendorName: "Express Cargo & Logistics Solutions" },
        chunkText: "Supplier: Express Cargo & Logistics Solutions",
      }),
      fakeSearchResult({
        invoiceId: "inv-2",
        invoice: { invoiceNumber: "INV-2026-001", vendorName: "ABC Technologies Pvt. Ltd." },
        chunkText: "Supplier: ABC Technologies Pvt. Ltd.",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue("The total logistics amount for Invoice INV-2026-2048 is 45,810 rupees."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "supplier", text: "Supplier: Express Cargo & Logistics Solutions" },
        { chunkType: "payment", text: "Grand Total: 45810", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "summarize the total logistics amount" });

    expect(result.answer).toMatch(/doesn't match anything on file/);
  });

  it("does not flag a real invoice number, or a differently-shaped identifier like a PO number, as fabricated", async () => {
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
          "Invoice EXL-2026-2048 (PO-45879) from Express Cargo & Logistics Solutions totals 45810."
        ),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Invoice Number: EXL-2026-2048\nPO Number: PO-45879", _id: { toString: () => "chunk-header" } },
        { chunkType: "supplier", text: "Supplier: Express Cargo & Logistics Solutions" },
        { chunkType: "payment", text: "Grand Total: 45810", _id: { toString: () => "chunk-payment" } },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({
      question: "What is the grand total and PO number for Express Cargo?",
    });

    expect(result.answer).toBe(
      "Invoice EXL-2026-2048 (PO-45879) from Express Cargo & Logistics Solutions totals 45810."
    );
  });

  it("narrows a shared vendor name to the specific invoice instead of treating it as a multi-invoice answer", async () => {
    // Reproduces the confirmed live bug: "The total for the SuperStore computer
    // invoices is $1,330.29" matched BOTH of SuperStore's real invoices (24938 and
    // 27639) on the same vendor-name string -- the old boolean mentionsInvoice() logic
    // counted that as "2 invoices named" and skipped verification entirely, the same
    // bypass meant for genuinely different invoices ("Vendor One and Vendor Two"). This
    // proves the fix: the answer here names only the shared vendor (no invoice number),
    // states a number that's real but belongs to the WRONG SuperStore invoice for the
    // question asked, and should now be narrowed and rejected instead of skipped.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-24938",
        invoice: { invoiceNumber: "24938", vendorName: "SuperStore" },
        chunkText: "Customer: Benjamin Farhat",
      }),
      fakeSearchResult({
        invoiceId: "inv-27639",
        invoice: { invoiceNumber: "27639", vendorName: "SuperStore" },
        chunkText: "Customer: Steve Carroll",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("The total for the SuperStore invoice is 4148.2."),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockImplementation((invoiceId: string) => {
        if (invoiceId === "inv-24938") {
          return Promise.resolve([
            { chunkType: "customer", text: "Customer: Benjamin Farhat" },
            { chunkType: "payment", text: "Grand Total: 8589.05", _id: { toString: () => "chunk-24938-payment" } },
          ]);
        }
        return Promise.resolve([
          { chunkType: "customer", text: "Customer: Steve Carroll" },
          { chunkType: "payment", text: "Grand Total: 4148.2", _id: { toString: () => "chunk-27639-payment" } },
        ]);
      }),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "How much did Benjamin Farhat pay?" });

    // 4148.2 uniquely attributes to invoice 27639 (Steve Carroll's), not 24938
    // (Benjamin Farhat's) -- the question asks about Farhat specifically, and "farhat"
    // never appears in 27639's own text, so this must be rejected, not skipped.
    expect(result.answer).toMatch(/doesn't appear to mention what you asked about/);
  });

  it("rejects a premise mismatch even when the answer names the invoice, once generic payment vocabulary is excluded from the overlap check", async () => {
    // Reproduces the confirmed live bug: "summarize the electricity bill amount" named
    // a real invoice and cited its real Installation Service line ($5,000), but only
    // passed the premise check because "amount" is a genuine word in that invoice's own
    // line items -- "electricity" itself, the actual topic, never appears anywhere.
    const searchResults = [
      fakeSearchResult({
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-2026-001", vendorName: "ABC Technologies Pvt. Ltd." },
        chunkText: "Supplier: ABC Technologies Pvt. Ltd.",
      }),
    ];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue(
          "The invoice for the electricity bill is Invoice INV-2026-001. The total amount for the electricity service provided is 5000 rupees."
        ),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "RETRIEVAL" });
    const repository = fakeRepository({
      findChunksByInvoiceId: vi.fn().mockResolvedValue([
        { chunkType: "header", text: "Supplier: ABC Technologies Pvt. Ltd.", _id: { toString: () => "chunk-header" } },
        { chunkType: "line_items", text: "Installation Service, qty 1, unit price 5000, amount 5000" },
      ]),
    });

    const service = new RagService(searchService, ollamaService, spendQueryService, chatIntentService, repository);
    const result = await service.answer({ question: "summarize the electricity bill amount" });

    expect(result.answer).toMatch(/doesn't appear to mention what you asked about/);
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

describe("RagService.answer — line-item aggregation path", () => {
  it("answers with a real computed sum from each matched line item's own amount, never the model's arithmetic", async () => {
    // Reproduces the confirmed live bug: "summarize the total computer invoice related
    // amount" let the model pick a garbled fragment and do its own (sometimes wrong)
    // arithmetic on top of it. This path never calls the model for the number at all.
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const ollamaService = { chatCompletion: vi.fn() } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "LINE_ITEM_AGGREGATION", keyword: "computer" });
    const lineItemAggregationService = fakeLineItemAggregationService({
      getLineItemTotal: vi.fn().mockResolvedValue({
        keyword: "computer",
        totalAmount: 4069.53,
        currencies: ["USD"],
        items: [
          {
            invoiceNumber: "27639",
            vendorName: "SuperStore",
            description: "Chromcraft Computer Table, with Bottom Storage, qty 3, amount 4069.53",
            amount: 4069.53,
          },
        ],
      }),
    });

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository(),
      fakeInvoiceStatusQueryService(),
      lineItemAggregationService
    );
    const result = await service.answer({ question: "summarize the total computer invoice related amount" });

    expect(result.mode).toBe("computed");
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain('matching "computer"');
    expect(result.answer).toContain("USD 4069.53");
    expect(result.answer).toContain("27639");
    expect(searchService.search).not.toHaveBeenCalled();
    expect(ollamaService.chatCompletion).not.toHaveBeenCalled();
    expect(lineItemAggregationService.getLineItemTotal).toHaveBeenCalledWith("computer");
  });

  it("prefers a real vendor-name match over line-item aggregation when the keyword collides with a vendor's name", async () => {
    // Reproduces the confirmed live bug, deterministically (3/3 identical calls): "the
    // total logistics amount" classified as LINE_ITEM_AGGREGATION with a paraphrased
    // keyword ("logistics services"), even though "Logistics" is literally part of a
    // real vendor's name (Express Cargo & Logistics Solutions) -- giving a wrong total
    // from unrelated line items instead of that vendor's real spend.
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const ollamaService = {} as unknown as OllamaService;
    const spendQueryService = {
      getVendorSpendSummary: vi.fn().mockImplementation(({ vendorNamePattern }) => {
        const pattern = new RegExp(vendorNamePattern, "i");
        if (pattern.test("Express Cargo & Logistics Solutions")) {
          return Promise.resolve({
            vendorNames: ["Express Cargo & Logistics Solutions"],
            invoiceCount: 1,
            totalAmount: 45810,
            currencies: ["INR"],
          });
        }
        return Promise.resolve(null);
      }),
    } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "LINE_ITEM_AGGREGATION", keyword: "logistics services" });
    const lineItemAggregationService = fakeLineItemAggregationService();

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository(),
      fakeInvoiceStatusQueryService(),
      lineItemAggregationService
    );
    const result = await service.answer({ question: "summarize the total logistics amount" });

    expect(result.mode).toBe("computed");
    expect(result.answer).toContain("Express Cargo & Logistics Solutions");
    expect(result.answer).toContain("INR 45810.00");
    expect(lineItemAggregationService.getLineItemTotal).not.toHaveBeenCalled();
  });

  it("falls through to retrieval when no line items matched the keyword", async () => {
    const searchResults = [fakeSearchResult({ chunkText: "unrelated text" })];
    const searchService = { search: vi.fn().mockResolvedValue({ results: searchResults }) } as unknown as SearchService;
    const ollamaService = {
      chatCompletion: vi.fn().mockResolvedValue("Some retrieved answer"),
    } as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "LINE_ITEM_AGGREGATION", keyword: "spaceship parts" });
    const lineItemAggregationService = fakeLineItemAggregationService();

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository(),
      fakeInvoiceStatusQueryService(),
      lineItemAggregationService
    );
    const result = await service.answer({ question: "How much did I spend on spaceship parts?" });

    expect(result.mode).toBe("retrieved");
    expect(searchService.search).toHaveBeenCalled();
    expect(result.answer).toBe("Some retrieved answer");
  });

  it("flags mixed currencies instead of silently presenting one summed figure", async () => {
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const ollamaService = {} as unknown as OllamaService;
    const spendQueryService = { getVendorSpendSummary: vi.fn() } as unknown as SpendQueryService;
    const chatIntentService = fakeChatIntentService({ type: "LINE_ITEM_AGGREGATION", keyword: "furniture" });
    const lineItemAggregationService = fakeLineItemAggregationService({
      getLineItemTotal: vi.fn().mockResolvedValue({
        keyword: "furniture",
        totalAmount: 1500,
        currencies: ["USD", "INR"],
        items: [
          { invoiceNumber: "A", vendorName: "Vendor A", description: "Desk, amount 1000", amount: 1000 },
          { invoiceNumber: "B", vendorName: "Vendor B", description: "Chair, amount 500", amount: 500 },
        ],
      }),
    });

    const service = new RagService(
      searchService,
      ollamaService,
      spendQueryService,
      chatIntentService,
      fakeRepository(),
      fakeInvoiceStatusQueryService(),
      lineItemAggregationService
    );
    const result = await service.answer({ question: "What's the total for furniture?" });

    expect(result.mode).toBe("computed");
    expect(result.answer).toMatch(/different currencies/);
  });
});

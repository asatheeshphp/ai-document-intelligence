import { describe, it, expect, vi } from "vitest";
import { Types } from "mongoose";
import { SearchService } from "@/services/search.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { VectorRepository } from "@/repositories/vector.repository";
import type { E5Service } from "@/services/e5.service";
import type { OllamaService } from "@/services/ollama.service";

function makeEmbedding(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    invoiceId: new Types.ObjectId(),
    documentId: new Types.ObjectId(),
    chunkId: new Types.ObjectId(),
    chunkType: "supplier",
    embeddingModel: "multilingual-e5-base",
    embeddingVector: [1, 0, 0],
    status: "COMPLETED",
    ...overrides,
  };
}

function makeChunk(id: Types.ObjectId, text: string) {
  return { _id: id, text };
}

function makeInvoice(id: Types.ObjectId, vendorName: string) {
  return { _id: id, vendorName, invoiceNumber: null, customerName: null, invoiceDate: null, totalAmount: null };
}

describe("SearchService.search", () => {
  it("ranks the invoice whose chunk verbatim-contains the query above a vector-only near-tie", async () => {
    // Regression guard for the originally-documented bug (querying "CloudNova" returned
    // Medicare's chunk as #1) — the lexical boost must decisively win a verbatim keyword
    // match even when a near-tied embedding score would otherwise rank a different
    // invoice's chunk first, regardless of which embedding model is in use.
    const cloudNovaInvoiceId = new Types.ObjectId();
    const medicareInvoiceId = new Types.ObjectId();
    const cloudNovaChunkId = new Types.ObjectId();
    const medicareChunkId = new Types.ObjectId();

    const cloudNovaEmbedding = makeEmbedding({
      invoiceId: cloudNovaInvoiceId,
      chunkId: cloudNovaChunkId,
      embeddingVector: [1, 0, 0],
    });
    const medicareEmbedding = makeEmbedding({
      invoiceId: medicareInvoiceId,
      chunkId: medicareChunkId,
      // Slightly higher raw cosine similarity to the query vector than CloudNova's,
      // reproducing the observed vector-space anisotropy.
      embeddingVector: [0.999, 0.001, 0],
    });

    const fakeE5Service = {
      embedText: vi.fn().mockResolvedValue([1, 0, 0]),
    } as unknown as E5Service;

    const fakeVectorRepository = {
      findAllEmbeddings: vi.fn().mockResolvedValue([cloudNovaEmbedding, medicareEmbedding]),
    } as unknown as VectorRepository;

    const fakeProcessingRepository = {
      findChunksByIds: vi
        .fn()
        .mockResolvedValue([
          makeChunk(cloudNovaChunkId, "Supplier: CloudNova Software"),
          makeChunk(medicareChunkId, "Supplier: Medicare Pharma"),
        ]),
      findInvoicesByIds: vi
        .fn()
        .mockResolvedValue([
          makeInvoice(cloudNovaInvoiceId, "CloudNova Software"),
          makeInvoice(medicareInvoiceId, "Medicare Pharma"),
        ]),
    } as unknown as ProcessingRepository;

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeE5Service);
    const { results } = await service.search({ query: "CloudNova", threshold: 0 });

    expect(results[0].invoice?.vendorName).toBe("CloudNova Software");
  });

  it("clamps the returned score at 1 even when the lexical boost pushes the combined score above it", async () => {
    // A verbatim keyword match on top of a near-perfect vector match combines to above
    // 1.0 (vectorScore + LEXICAL_BOOST * lexicalScore, e.g. 1.0 + 0.5). The UI renders
    // this as "N% match", so a raw value above 1 would display as a nonsensical >100%.
    const invoiceId = new Types.ObjectId();
    const chunkId = new Types.ObjectId();

    const embedding = makeEmbedding({
      invoiceId,
      chunkId,
      embeddingVector: [1, 0, 0],
    });

    const fakeE5Service = {
      embedText: vi.fn().mockResolvedValue([1, 0, 0]),
    } as unknown as E5Service;

    const fakeVectorRepository = {
      findAllEmbeddings: vi.fn().mockResolvedValue([embedding]),
    } as unknown as VectorRepository;

    const fakeProcessingRepository = {
      findChunksByIds: vi.fn().mockResolvedValue([makeChunk(chunkId, "Supplier: CloudNova Software")]),
      findInvoicesByIds: vi.fn().mockResolvedValue([makeInvoice(invoiceId, "CloudNova Software")]),
    } as unknown as ProcessingRepository;

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeE5Service);
    const { results } = await service.search({ query: "CloudNova", threshold: 0 });

    expect(results[0].score).toBeLessThanOrEqual(1);
    expect(results[0].score).toBe(1);
  });

  it("scopes candidates to the month named in the query instead of searching across all invoices", async () => {
    // Reproduces the reported confusion: "What products or services were billed for in
    // July?" previously had no notion of "July" at all — a June 2014 invoice that
    // happened to score well on general phrasing would surface right alongside a
    // genuine July 2026 invoice. A month named in the query should restrict candidates
    // to that month, the same way an explicit invoiceDateFrom/To filter would.
    const julyInvoiceId = new Types.ObjectId();
    const julyChunkId = new Types.ObjectId();
    const julyEmbedding = makeEmbedding({
      invoiceId: julyInvoiceId,
      chunkId: julyChunkId,
      embeddingVector: [1, 0, 0],
    });

    const fakeE5Service = { embedText: vi.fn().mockResolvedValue([1, 0, 0]) } as unknown as E5Service;

    const listInvoices = vi.fn().mockResolvedValue([makeInvoice(julyInvoiceId, "Express Cargo & Logistics")]);
    const findAllEmbeddings = vi.fn();
    const findEmbeddingsByInvoiceIds = vi.fn().mockResolvedValue([julyEmbedding]);

    const fakeVectorRepository = {
      findAllEmbeddings,
      findEmbeddingsByInvoiceIds,
    } as unknown as VectorRepository;

    const fakeProcessingRepository = {
      listInvoices,
      findChunksByIds: vi.fn().mockResolvedValue([makeChunk(julyChunkId, "Transportation Coimbatore -> Chennai")]),
      findInvoicesByIds: vi.fn().mockResolvedValue([makeInvoice(julyInvoiceId, "Express Cargo & Logistics")]),
    } as unknown as ProcessingRepository;

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeE5Service);
    const { results } = await service.search({
      query: "What products or services were billed for in July 2026?",
      threshold: 0,
    });

    expect(listInvoices).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceDate: expect.objectContaining({ $gte: expect.any(Date), $lte: expect.any(Date) }),
      })
    );
    // Candidates came from the date-scoped invoice lookup, not an unscoped full scan.
    expect(findAllEmbeddings).not.toHaveBeenCalled();
    expect(findEmbeddingsByInvoiceIds).toHaveBeenCalledWith([julyInvoiceId]);
    expect(results).toHaveLength(1);
    expect(results[0].invoice?.vendorName).toBe("Express Cargo & Logistics");
  });

  it("caps how many chunks a single invoice can contribute, leaving room for other invoices", async () => {
    // Reproduces the reported UX confusion: a single invoice with many chunks (per
    // line item, per tax entry) can otherwise fill every result slot with its own
    // near-duplicate/low-signal fragments, reading as "duplicate data" even though
    // it's genuinely one invoice, and crowding out other real candidates.
    const dominantInvoiceId = new Types.ObjectId();
    const otherInvoiceId = new Types.ObjectId();

    const dominantEmbeddings = Array.from({ length: 6 }, () =>
      makeEmbedding({ invoiceId: dominantInvoiceId, chunkId: new Types.ObjectId(), embeddingVector: [1, 0, 0] })
    );
    const otherEmbedding = makeEmbedding({
      invoiceId: otherInvoiceId,
      chunkId: new Types.ObjectId(),
      embeddingVector: [0.95, 0, Math.sqrt(1 - 0.95 * 0.95)],
    });

    const fakeE5Service = { embedText: vi.fn().mockResolvedValue([1, 0, 0]) } as unknown as E5Service;

    const fakeVectorRepository = {
      findAllEmbeddings: vi.fn().mockResolvedValue([...dominantEmbeddings, otherEmbedding]),
    } as unknown as VectorRepository;

    const allChunkIds = [...dominantEmbeddings, otherEmbedding].map((e) => e.chunkId);
    const fakeProcessingRepository = {
      findChunksByIds: vi.fn().mockResolvedValue(allChunkIds.map((id) => makeChunk(id, "generic chunk text"))),
      findInvoicesByIds: vi
        .fn()
        .mockResolvedValue([makeInvoice(dominantInvoiceId, "Dominant Vendor"), makeInvoice(otherInvoiceId, "Other Vendor")]),
    } as unknown as ProcessingRepository;

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeE5Service);
    const { results } = await service.search({ query: "generic invoice query", threshold: 0, topK: 10 });

    const dominantCount = results.filter((r) => r.invoiceId === dominantInvoiceId.toString()).length;
    const otherCount = results.filter((r) => r.invoiceId === otherInvoiceId.toString()).length;

    expect(dominantCount).toBe(1);
    expect(otherCount).toBe(1);
  });

  it("falls back to a translated query when a non-ASCII query finds nothing", async () => {
    // Reproduces the measured, structural gap: a genuine non-English query with no
    // literal anchor can score too low to clear the threshold even though the model
    // "knows" the right answer conceptually, confirmed by comparing genuine vs.
    // nonsense scores across languages (see search.service.ts's fallback comment).
    // Simulates that here by making the original-language embedding score low and the
    // translated-English embedding score well above threshold.
    const invoiceId = new Types.ObjectId();
    const chunkId = new Types.ObjectId();
    const embedding = makeEmbedding({ invoiceId, chunkId, embeddingVector: [1, 0, 0] });

    const embedText = vi.fn().mockImplementation(async (text: string) => {
      return text === "translated english query" ? [1, 0, 0] : [0, 1, 0];
    });
    const fakeE5Service = { embedText } as unknown as E5Service;

    const translateToEnglish = vi.fn().mockResolvedValue("translated english query");
    const fakeOllamaService = { translateToEnglish } as unknown as OllamaService;

    const fakeVectorRepository = {
      findAllEmbeddings: vi.fn().mockResolvedValue([embedding]),
    } as unknown as VectorRepository;

    const fakeProcessingRepository = {
      findChunksByIds: vi.fn().mockResolvedValue([makeChunk(chunkId, "generic chunk text")]),
      findInvoicesByIds: vi.fn().mockResolvedValue([makeInvoice(invoiceId, "Some Vendor")]),
    } as unknown as ProcessingRepository;

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeE5Service, fakeOllamaService);
    const nonAsciiQuery = "தமிழ் கேள்வி";
    const { results } = await service.search({ query: nonAsciiQuery });

    expect(translateToEnglish).toHaveBeenCalledWith(nonAsciiQuery);
    expect(embedText).toHaveBeenCalledWith(nonAsciiQuery, "query");
    expect(embedText).toHaveBeenCalledWith("translated english query", "query");
    expect(results).toHaveLength(1);
    expect(results[0].invoiceId).toBe(invoiceId.toString());
  });

  it("does not attempt translation for a plain-ASCII query that finds nothing", async () => {
    const embedText = vi.fn().mockResolvedValue([0, 1, 0]);
    const fakeE5Service = { embedText } as unknown as E5Service;

    const translateToEnglish = vi.fn().mockResolvedValue("should not be called");
    const fakeOllamaService = { translateToEnglish } as unknown as OllamaService;

    const fakeVectorRepository = {
      findAllEmbeddings: vi.fn().mockResolvedValue([makeEmbedding({ embeddingVector: [1, 0, 0] })]),
    } as unknown as VectorRepository;

    const fakeProcessingRepository = {
      findChunksByIds: vi.fn().mockResolvedValue([]),
      findInvoicesByIds: vi.fn().mockResolvedValue([]),
    } as unknown as ProcessingRepository;

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeE5Service, fakeOllamaService);
    const { results } = await service.search({ query: "recipe for chocolate lava cake dessert" });

    expect(translateToEnglish).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });
});

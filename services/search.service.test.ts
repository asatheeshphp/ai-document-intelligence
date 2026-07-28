import { describe, it, expect, vi } from "vitest";
import { Types } from "mongoose";
import { SearchService } from "@/services/search.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { VectorRepository } from "@/repositories/vector.repository";
import type { SiglipService } from "@/services/siglip.service";

function makeEmbedding(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    invoiceId: new Types.ObjectId(),
    documentId: new Types.ObjectId(),
    chunkId: new Types.ObjectId(),
    chunkType: "supplier",
    embeddingModel: "siglip2",
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
    // Reproduces the documented bug: querying "CloudNova" returned Medicare's chunk as
    // #1 because SigLIP2's cosine scores for short, template-heavy invoice text don't
    // reliably separate relevant from irrelevant content. Here Medicare's embedding is
    // deliberately given a slightly higher raw vector score than CloudNova's, mimicking
    // that anisotropy — the lexical boost must still put CloudNova's chunk on top since
    // the query literally appears in its text.
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

    const fakeSiglipService = {
      embedText: vi.fn().mockResolvedValue([1, 0, 0]),
    } as unknown as SiglipService;

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

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeSiglipService);
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

    const fakeSiglipService = {
      embedText: vi.fn().mockResolvedValue([1, 0, 0]),
    } as unknown as SiglipService;

    const fakeVectorRepository = {
      findAllEmbeddings: vi.fn().mockResolvedValue([embedding]),
    } as unknown as VectorRepository;

    const fakeProcessingRepository = {
      findChunksByIds: vi.fn().mockResolvedValue([makeChunk(chunkId, "Supplier: CloudNova Software")]),
      findInvoicesByIds: vi.fn().mockResolvedValue([makeInvoice(invoiceId, "CloudNova Software")]),
    } as unknown as ProcessingRepository;

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeSiglipService);
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

    const fakeSiglipService = { embedText: vi.fn().mockResolvedValue([1, 0, 0]) } as unknown as SiglipService;

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

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeSiglipService);
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

    const fakeSiglipService = { embedText: vi.fn().mockResolvedValue([1, 0, 0]) } as unknown as SiglipService;

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

    const service = new SearchService(fakeProcessingRepository, fakeVectorRepository, fakeSiglipService);
    const { results } = await service.search({ query: "generic invoice query", threshold: 0, topK: 10 });

    const dominantCount = results.filter((r) => r.invoiceId === dominantInvoiceId.toString()).length;
    const otherCount = results.filter((r) => r.invoiceId === otherInvoiceId.toString()).length;

    expect(dominantCount).toBe(1);
    expect(otherCount).toBe(1);
  });
});

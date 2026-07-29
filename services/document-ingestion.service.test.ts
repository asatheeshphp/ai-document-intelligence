import { describe, it, expect, vi } from "vitest";
import { Types } from "mongoose";
import { DocumentIngestionService } from "@/services/document-ingestion.service";
import { DocumentQualityService } from "@/services/document-quality.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { OllamaService } from "@/services/ollama.service";
import type { InvoiceIndexingService } from "@/services/invoice-indexing.service";
import type { VisionExtractionService } from "@/services/vision-extraction.service";
import type { DocumentClassifierService } from "@/services/document-classifier.service";

vi.mock("node:fs/promises", () => ({
  default: {
    // JPEG magic bytes, not valid UTF-8 text — decoding this as UTF-8 (the old
    // behavior for any non-.pdf file) would produce garbled replacement-character text.
    readFile: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
  },
}));

function fakeRepository(overrides: Record<string, unknown> = {}): ProcessingRepository {
  return {
    deleteChunksByDocumentId: vi.fn().mockResolvedValue(undefined),
    deleteEmbeddingsByDocumentId: vi.fn().mockResolvedValue(undefined),
    deleteInvoicesByDocumentId: vi.fn().mockResolvedValue(undefined),
    deleteExtractionsByDocumentId: vi.fn().mockResolvedValue(undefined),
    deleteDocumentById: vi.fn().mockResolvedValue(undefined),
    deleteEmailById: vi.fn().mockResolvedValue(undefined),
    createEmail: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    upsertDocumentBySourcePath: vi.fn().mockResolvedValue({ document: { _id: new Types.ObjectId() }, isNew: true }),
    updateDocumentStatus: vi.fn().mockResolvedValue(undefined),
    createExtraction: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    createInvoice: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    listInvoices: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ProcessingRepository;
}

describe("DocumentIngestionService.processLocalDocument — image files", () => {
  it("routes a JPEG straight to vision extraction instead of decoding it as UTF-8 text", async () => {
    const repository = fakeRepository();
    const visionExtractText = vi.fn().mockResolvedValue("Invoice Number: INV-9001\nVendor: GreenLeaf");
    const visionExtractionService = {
      extractText: visionExtractText,
    } as unknown as VisionExtractionService;

    const documentClassifierService = {
      classify: vi.fn().mockResolvedValue({ documentType: "INVOICE", confidence: 0.9 }),
    } as unknown as DocumentClassifierService;

    const ollamaService = {
      // success:false is enough here — this test only cares about how the raw
      // image bytes are turned into text upstream, not the invoice-mapping path.
      extractInvoiceData: vi.fn().mockResolvedValue({ success: false, data: null, raw: "", error: "n/a" }),
    } as unknown as OllamaService;

    const indexingService = {
      replaceChunksAndEmbeddings: vi.fn().mockResolvedValue(undefined),
    } as unknown as InvoiceIndexingService;

    const service = new DocumentIngestionService(
      repository,
      ollamaService,
      indexingService,
      new DocumentQualityService(),
      visionExtractionService,
      documentClassifierService
    );

    await service.processLocalDocument({ sourcePath: "data/samples/invoice.jpg" });

    // isPdf=false — the raw image buffer must be handed to the vision model directly,
    // not run through the PDF page renderer.
    expect(visionExtractText).toHaveBeenCalledWith(expect.any(Buffer), false);

    // The document actually created must carry the vision-recovered text, not a
    // UTF-8 decoding of the JPEG's binary bytes.
    const upsertCall = vi.mocked(repository.upsertDocumentBySourcePath).mock.calls[0];
    expect(upsertCall[1].extractedText).toBe("Invoice Number: INV-9001\nVendor: GreenLeaf");
  });
});

describe("DocumentIngestionService.processLocalDocument — re-ingestion", () => {
  it("deletes the prior invoice only once re-extraction actually succeeds", async () => {
    // upsertDocumentBySourcePath is atomic and already guarantees a single Document row
    // per source path (see ProcessingRepository) — isNew:false here means this call
    // reused an existing row. The old Invoice must only be cleared once a full new
    // extraction has actually succeeded, not eagerly beforehand — see the two tests
    // below for the regression this guards against. Chunk/embedding replacement is the
    // mocked indexingService's own responsibility (see invoice-indexing.service.ts), and
    // Extraction rows are never deleted — every attempt is kept as history.
    const existingDocumentId = new Types.ObjectId();
    const repository = fakeRepository({
      upsertDocumentBySourcePath: vi
        .fn()
        .mockResolvedValue({ document: { _id: existingDocumentId }, isNew: false }),
    });

    const visionExtractionService = {
      extractText: vi.fn().mockResolvedValue("Invoice Number: INV-9002"),
    } as unknown as VisionExtractionService;

    const documentClassifierService = {
      classify: vi.fn().mockResolvedValue({ documentType: "INVOICE", confidence: 0.9 }),
    } as unknown as DocumentClassifierService;

    const ollamaService = {
      extractInvoiceData: vi.fn().mockResolvedValue({
        success: true,
        data: {
          invoice: { invoiceNumber: "INV-9002", invoiceDate: null, dueDate: null, poNumber: null, currency: null },
          supplier: { name: "Vendor Co" },
          customer: { name: "Customer Co" },
          totals: { subtotal: null, totalTax: null, grandTotal: null },
        },
        raw: "{}",
      }),
    } as unknown as OllamaService;

    const indexingService = {
      replaceChunksAndEmbeddings: vi.fn().mockResolvedValue(undefined),
    } as unknown as InvoiceIndexingService;

    const service = new DocumentIngestionService(
      repository,
      ollamaService,
      indexingService,
      new DocumentQualityService(),
      visionExtractionService,
      documentClassifierService
    );

    await service.processLocalDocument({ sourcePath: "data/samples/invoice.jpg" });

    expect(repository.upsertDocumentBySourcePath).toHaveBeenCalledWith(
      expect.stringContaining("invoice.jpg"),
      expect.objectContaining({ extractedText: "Invoice Number: INV-9002" })
    );
    expect(repository.deleteInvoicesByDocumentId).toHaveBeenCalledWith(existingDocumentId);
    expect(repository.deleteExtractionsByDocumentId).not.toHaveBeenCalled();
  });

  it("preserves the prior invoice/chunks/embeddings when re-extraction fails, instead of wiping them", async () => {
    // Confirmed live: re-processing an already-successfully-extracted invoice got it
    // reclassified as "OTHER" on the second run (LLM classification isn't perfectly
    // deterministic run-to-run), and the old eager-delete wiped the existing
    // Invoice/chunks/embeddings down to zero with nothing to replace them. This is the
    // direct regression test for that bug.
    const existingDocumentId = new Types.ObjectId();
    const repository = fakeRepository({
      upsertDocumentBySourcePath: vi
        .fn()
        .mockResolvedValue({ document: { _id: existingDocumentId }, isNew: false }),
    });

    const visionExtractionService = {
      extractText: vi.fn().mockResolvedValue("Invoice Number: INV-9002"),
    } as unknown as VisionExtractionService;

    const documentClassifierService = {
      classify: vi.fn().mockResolvedValue({ documentType: "NOT_INVOICE", confidence: 0.7 }),
    } as unknown as DocumentClassifierService;

    const ollamaService = { extractInvoiceData: vi.fn() } as unknown as OllamaService;

    const indexingService = {
      replaceChunksAndEmbeddings: vi.fn().mockResolvedValue(undefined),
    } as unknown as InvoiceIndexingService;

    const service = new DocumentIngestionService(
      repository,
      ollamaService,
      indexingService,
      new DocumentQualityService(),
      visionExtractionService,
      documentClassifierService
    );

    await service.processLocalDocument({ sourcePath: "data/samples/invoice.jpg" });

    expect(repository.deleteChunksByDocumentId).not.toHaveBeenCalled();
    expect(repository.deleteEmbeddingsByDocumentId).not.toHaveBeenCalled();
    expect(repository.deleteInvoicesByDocumentId).not.toHaveBeenCalled();
    expect(repository.deleteExtractionsByDocumentId).not.toHaveBeenCalled();
    expect(indexingService.replaceChunksAndEmbeddings).not.toHaveBeenCalled();
  });

  it("does not delete anything when the document is newly created", async () => {
    const repository = fakeRepository();

    const visionExtractionService = {
      extractText: vi.fn().mockResolvedValue("Invoice Number: INV-9003"),
    } as unknown as VisionExtractionService;

    const documentClassifierService = {
      classify: vi.fn().mockResolvedValue({ documentType: "INVOICE", confidence: 0.9 }),
    } as unknown as DocumentClassifierService;

    const ollamaService = {
      extractInvoiceData: vi.fn().mockResolvedValue({ success: false, data: null, raw: "", error: "n/a" }),
    } as unknown as OllamaService;

    const indexingService = {
      replaceChunksAndEmbeddings: vi.fn().mockResolvedValue(undefined),
    } as unknown as InvoiceIndexingService;

    const service = new DocumentIngestionService(
      repository,
      ollamaService,
      indexingService,
      new DocumentQualityService(),
      visionExtractionService,
      documentClassifierService
    );

    await service.processLocalDocument({ sourcePath: "data/samples/invoice-new.jpg" });

    expect(repository.deleteChunksByDocumentId).not.toHaveBeenCalled();
    expect(repository.deleteEmbeddingsByDocumentId).not.toHaveBeenCalled();
    expect(repository.deleteInvoicesByDocumentId).not.toHaveBeenCalled();
    expect(repository.deleteExtractionsByDocumentId).not.toHaveBeenCalled();
  });
});

describe("DocumentIngestionService.processLocalDocument — duplicate invoice check", () => {
  const validExtractionData = {
    invoice: { invoiceNumber: "INV-1001", invoiceDate: "2026-07-20", dueDate: null, poNumber: null, currency: null },
    supplier: { name: "Vendor Co" },
    customer: { name: "Customer Co" },
    totals: { subtotal: null, totalTax: null, grandTotal: null },
  };

  function buildService(repository: ProcessingRepository) {
    const visionExtractionService = {
      extractText: vi.fn().mockResolvedValue("Invoice Number: INV-1001"),
    } as unknown as VisionExtractionService;

    const documentClassifierService = {
      classify: vi.fn().mockResolvedValue({ documentType: "INVOICE", confidence: 0.9 }),
    } as unknown as DocumentClassifierService;

    const ollamaService = {
      extractInvoiceData: vi.fn().mockResolvedValue({ success: true, data: validExtractionData, raw: "{}" }),
    } as unknown as OllamaService;

    const indexingService = {
      replaceChunksAndEmbeddings: vi.fn().mockResolvedValue(undefined),
    } as unknown as InvoiceIndexingService;

    return new DocumentIngestionService(
      repository,
      ollamaService,
      indexingService,
      new DocumentQualityService(),
      visionExtractionService,
      documentClassifierService
    );
  }

  it("flags a document DUPLICATE_REVIEW instead of creating an invoice, when vendor/number/date already exist elsewhere", async () => {
    const existingDocumentId = new Types.ObjectId();
    const otherDocumentId = new Types.ObjectId();
    const repository = fakeRepository({
      upsertDocumentBySourcePath: vi
        .fn()
        .mockResolvedValue({ document: { _id: existingDocumentId, metadata: {} }, isNew: true }),
      listInvoices: vi.fn().mockResolvedValue([{ documentId: otherDocumentId }]),
    });

    const service = buildService(repository);
    const result = await service.processLocalDocument({ sourcePath: "data/samples/invoice-dup.pdf" });

    expect(repository.listInvoices).toHaveBeenCalledWith({
      vendorName: "Vendor Co",
      invoiceNumber: "INV-1001",
      invoiceDate: expect.any(Date),
      documentId: { $ne: existingDocumentId },
    });
    expect(repository.createInvoice).not.toHaveBeenCalled();
    expect(result.invoice).toBeNull();
    expect(result.message).toMatch(/Duplicate invoice detected/);
    expect(result.message).toMatch(/flagged for review/);

    // Nothing is deleted -- a human decides via processDuplicateAnyway or the existing
    // DELETE /api/documents/:id endpoint. The document is marked, not discarded.
    expect(repository.deleteDocumentById).not.toHaveBeenCalled();
    expect(repository.deleteEmailById).not.toHaveBeenCalled();
    expect(repository.deleteExtractionsByDocumentId).not.toHaveBeenCalled();
    expect(repository.updateDocumentStatus).toHaveBeenCalledWith(
      existingDocumentId,
      "DUPLICATE_REVIEW",
      expect.objectContaining({
        lastError: expect.stringContaining("Duplicate invoice detected"),
        metadata: expect.objectContaining({ duplicateOfDocumentId: otherDocumentId.toString() }),
      })
    );
  });

  it("creates the invoice normally when no duplicate exists", async () => {
    const documentId = new Types.ObjectId();
    const repository = fakeRepository({
      upsertDocumentBySourcePath: vi.fn().mockResolvedValue({ document: { _id: documentId }, isNew: true }),
      listInvoices: vi.fn().mockResolvedValue([]),
    });

    const service = buildService(repository);
    const result = await service.processLocalDocument({ sourcePath: "data/samples/invoice-unique.pdf" });

    expect(repository.createInvoice).toHaveBeenCalledTimes(1);
    expect(result.invoice).not.toBeNull();
  });

  it("excludes this document's own prior invoice from the duplicate check when reprocessing", async () => {
    const existingDocumentId = new Types.ObjectId();
    const listInvoices = vi.fn().mockResolvedValue([]);
    const repository = fakeRepository({
      upsertDocumentBySourcePath: vi
        .fn()
        .mockResolvedValue({ document: { _id: existingDocumentId }, isNew: false }),
      listInvoices,
    });

    const service = buildService(repository);
    await service.processLocalDocument({ sourcePath: "data/samples/invoice-reprocess.pdf" });

    expect(listInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: { $ne: existingDocumentId } })
    );
    expect(repository.deleteInvoicesByDocumentId).toHaveBeenCalledWith(existingDocumentId);
    expect(repository.createInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("DocumentIngestionService.processDuplicateAnyway", () => {
  const structuredData = {
    invoice: { invoiceNumber: "INV-1001", invoiceDate: "2026-07-20", dueDate: null, poNumber: null, currency: null },
    supplier: { name: "Vendor Co" },
    customer: { name: "Customer Co" },
    totals: { subtotal: null, totalTax: null, grandTotal: null },
  };

  function buildService(repository: ProcessingRepository) {
    return new DocumentIngestionService(
      repository,
      {} as unknown as OllamaService,
      { replaceChunksAndEmbeddings: vi.fn().mockResolvedValue(undefined) } as unknown as InvoiceIndexingService,
      new DocumentQualityService(),
      {} as unknown as VisionExtractionService,
      {} as unknown as DocumentClassifierService
    );
  }

  it("creates the invoice from the already-succeeded extraction, overriding the duplicate flag", async () => {
    const documentId = new Types.ObjectId();
    const repository = fakeRepository({
      findDocumentById: vi.fn().mockResolvedValue({ _id: documentId, status: "DUPLICATE_REVIEW" }),
      findExtractionsByDocumentId: vi
        .fn()
        .mockResolvedValue([{ status: "SUCCEEDED", structuredData }]),
      updateDocumentStatus: vi.fn().mockResolvedValue({ _id: documentId, status: "EXTRACTED" }),
    });

    const service = buildService(repository);
    const result = await service.processDuplicateAnyway(documentId);

    expect(result.success).toBe(true);
    expect(repository.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ documentId, vendorName: "Vendor Co", invoiceNumber: "INV-1001" })
    );
    expect(repository.updateDocumentStatus).toHaveBeenCalledWith(documentId, "EXTRACTED", { lastError: null });
    expect(result.document?.status).toBe("EXTRACTED");
  });

  it("fails if the document isn't flagged for duplicate review", async () => {
    const documentId = new Types.ObjectId();
    const repository = fakeRepository({
      findDocumentById: vi.fn().mockResolvedValue({ _id: documentId, status: "EXTRACTED" }),
    });

    const service = buildService(repository);
    const result = await service.processDuplicateAnyway(documentId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not flagged for duplicate review/);
    expect(repository.createInvoice).not.toHaveBeenCalled();
  });

  it("fails if no successful extraction exists to build the invoice from", async () => {
    const documentId = new Types.ObjectId();
    const repository = fakeRepository({
      findDocumentById: vi.fn().mockResolvedValue({ _id: documentId, status: "DUPLICATE_REVIEW" }),
      findExtractionsByDocumentId: vi.fn().mockResolvedValue([{ status: "FAILED", structuredData: {} }]),
    });

    const service = buildService(repository);
    const result = await service.processDuplicateAnyway(documentId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No successful extraction/);
  });

  it("fails if the document doesn't exist", async () => {
    const repository = fakeRepository({
      findDocumentById: vi.fn().mockResolvedValue(null),
    });

    const service = buildService(repository);
    const result = await service.processDuplicateAnyway(new Types.ObjectId());

    expect(result.success).toBe(false);
    expect(result.error).toBe("Document not found");
  });
});

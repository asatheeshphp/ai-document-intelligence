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
    createEmail: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    upsertDocumentBySourcePath: vi.fn().mockResolvedValue({ document: { _id: new Types.ObjectId() }, isNew: true }),
    updateDocumentStatus: vi.fn().mockResolvedValue(undefined),
    createExtraction: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    createInvoice: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
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
  it("deletes the prior invoice/chunks/embeddings for a re-ingested document instead of stacking new ones", async () => {
    // upsertDocumentBySourcePath is atomic and already guarantees a single Document row
    // per source path (see ProcessingRepository) — isNew:false here means this call
    // reused an existing row, so this run must clear that row's old downstream data
    // before creating fresh Extraction/Invoice/Chunk/Embedding records.
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

    expect(repository.upsertDocumentBySourcePath).toHaveBeenCalledWith(
      expect.stringContaining("invoice.jpg"),
      expect.objectContaining({ extractedText: "Invoice Number: INV-9002" })
    );
    expect(repository.deleteChunksByDocumentId).toHaveBeenCalledWith(existingDocumentId);
    expect(repository.deleteEmbeddingsByDocumentId).toHaveBeenCalledWith(existingDocumentId);
    expect(repository.deleteInvoicesByDocumentId).toHaveBeenCalledWith(existingDocumentId);
    expect(repository.deleteExtractionsByDocumentId).toHaveBeenCalledWith(existingDocumentId);
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

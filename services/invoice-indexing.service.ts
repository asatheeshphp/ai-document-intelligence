import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { E5Service } from "@/services/e5.service";
import { buildInvoiceChunks } from "@/schemas/invoice-chunker";
import type { InvoiceExtraction } from "@/schemas/invoice.schema";

export class InvoiceIndexingService {
  constructor(
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly e5Service: E5Service = new E5Service()
  ) {}

  /**
   * Rebuilds chunks + embeddings for a document from its current structured extraction.
   * Safe to call for a brand-new document (nothing to delete) or to re-index an
   * already-processed one after re-extraction. New embeddings are generated in full
   * BEFORE any existing chunk/embedding is deleted, so a mid-run failure leaves the
   * previous (stale but complete) index untouched rather than emptying it.
   */
  async replaceChunksAndEmbeddings(
    documentId: Types.ObjectId | string,
    invoiceId: Types.ObjectId | string,
    extraction: InvoiceExtraction,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const drafts = buildInvoiceChunks(extraction);

    const vectors: number[][] = [];
    for (const draft of drafts) {
      vectors.push(await this.e5Service.embedText(draft.text, "passage"));
    }

    await this.repository.deleteChunksByDocumentId(documentId);
    await this.repository.deleteEmbeddingsByDocumentId(documentId);

    for (let i = 0; i < drafts.length; i += 1) {
      const draft = drafts[i];
      const vector = vectors[i];

      const chunkDoc = await this.repository.createChunk({
        invoiceId,
        documentId,
        chunkType: draft.type,
        text: draft.text,
        startOffset: draft.start,
        endOffset: draft.end,
        tokenCount: draft.tokenCount,
        metadata,
      });

      await this.repository.createEmbedding({
        invoiceId,
        documentId,
        chunkId: chunkDoc._id,
        chunkType: draft.type,
        embeddingModel: "multilingual-e5-base",
        embeddingVector: vector,
        status: "COMPLETED",
        metadata,
      });
    }
  }
}

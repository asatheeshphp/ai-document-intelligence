import mongoose, { type UpdateQuery, type Types } from "mongoose";
import { BaseRepository } from "@/repositories/base.repository";
import { Email, type IEmail } from "@/models/email.model";
import { Document, type IDocument } from "@/models/document.model";
import { Extraction, type IExtraction } from "@/models/extraction.model";
import { Invoice, type IInvoice } from "@/models/invoice.model";
import { Embedding, type IEmbedding } from "@/models/embedding.model";

export interface CreateEmailInput {
  messageId: string;
  senderAddress: string;
  senderName?: string;
  subject?: string;
  receivedAt?: Date;
  source?: "INBOX" | "MANUAL";
  status?: IEmail["status"];
  metadata?: Record<string, unknown>;
}

export interface CreateDocumentInput {
  emailId: Types.ObjectId | string;
  documentType?: IDocument["documentType"];
  filename?: string;
  contentType?: string;
  fileSize?: number;
  storagePath?: string;
  checksum?: string;
  status?: IDocument["status"];
  extractedText?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateExtractionInput {
  documentId: Types.ObjectId | string;
  extractionType?: string;
  provider?: string;
  status?: IExtraction["status"];
  attempts?: number;
  modelName?: string;
  rawResponse?: string;
  structuredData?: Record<string, unknown>;
  inputTextHash?: string;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateInvoiceInput {
  documentId: Types.ObjectId | string;
  invoiceNumber?: string;
  vendorName?: string;
  customerName?: string;
  invoiceDate?: Date;
  dueDate?: Date;
  poNumber?: string;
  currency?: string;
  subtotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  status?: IInvoice["status"];
  extractedData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CreateEmbeddingInput {
  invoiceId: Types.ObjectId | string;
  documentId: Types.ObjectId | string;
  embeddingModel: string;
  embeddingVector: number[];
  chunkId?: Types.ObjectId | string;
  chunkType?: string;
  sourceTextHash?: string;
  status?: IEmbedding["status"];
  metadata?: Record<string, unknown>;
}

export interface CreateChunkInput {
  invoiceId: Types.ObjectId | string;
  documentId: Types.ObjectId | string;
  chunkType?: string;
  text: string;
  startOffset: number;
  endOffset: number;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface DashboardStats {
  totalDocuments: number;
  totalInvoices: number;
  totalChunks: number;
  totalEmbeddings: number;
  averageChunksPerDocument: number;
  processingSuccessCount: number;
  failedProcessingCount: number;
}

export interface DocumentSummaryItem {
  documentId: string;
  filename?: string;
  status: string;
  createdAt: Date;
  invoiceNumber?: string;
  vendorName?: string;
  customerName?: string;
  invoiceDate?: Date;
  totalAmount?: number;
  chunkCount: number;
}

export interface ListDocumentsSummaryInput {
  page?: number;
  limit?: number;
  vendorName?: string;
  status?: string;
}

export interface ListDocumentsSummaryResult {
  items: DocumentSummaryItem[];
  total: number;
  page: number;
  limit: number;
}

export class ProcessingRepository extends BaseRepository<unknown> {
  async createEmail(input: CreateEmailInput): Promise<IEmail> {
    return this.withConnection(async () => {
      const email = await Email.create({
        messageId: input.messageId,
        senderAddress: input.senderAddress,
        senderName: input.senderName,
        subject: input.subject,
        receivedAt: input.receivedAt ?? new Date(),
        source: input.source ?? "INBOX",
        status: input.status ?? "RECEIVED",
        metadata: input.metadata ?? {},
      });

      return email;
    });
  }

  async findEmailByMessageId(messageId: string): Promise<IEmail | null> {
    return this.withConnection(async () => {
      return Email.findOne({ messageId }).lean<IEmail>().exec();
    });
  }

  async createDocument(input: CreateDocumentInput): Promise<IDocument> {
    return this.withConnection(async () => {
      const document = await Document.create({
        emailId: input.emailId,
        documentType: input.documentType ?? "UNKNOWN",
        filename: input.filename,
        contentType: input.contentType,
        fileSize: input.fileSize,
        storagePath: input.storagePath,
        checksum: input.checksum,
        status: input.status ?? "PENDING",
        extractedText: input.extractedText,
        metadata: input.metadata ?? {},
      });

      return document;
    });
  }

  /**
   * Atomically creates-or-replaces the Document for a given local source file path, so
   * re-ingesting the same file can never leave two Document rows behind, even if two
   * requests for the same path race. Relies on DocumentSchema's unique index on
   * "metadata.sourcePath" — findOneAndUpdate's upsert is atomic at the database layer,
   * and the unique index is the backstop that rejects a genuinely concurrent second
   * insert (retried here as a plain update, which will then find the winner's row).
   */
  async upsertDocumentBySourcePath(
    sourcePath: string,
    input: CreateDocumentInput
  ): Promise<{ document: IDocument; isNew: boolean }> {
    return this.withConnection(async () => {
      const update = {
        emailId: input.emailId,
        documentType: input.documentType ?? "UNKNOWN",
        filename: input.filename,
        contentType: input.contentType,
        fileSize: input.fileSize,
        storagePath: input.storagePath,
        checksum: input.checksum,
        status: input.status ?? "PENDING",
        extractedText: input.extractedText,
        metadata: input.metadata ?? {},
      };
      const query = { "metadata.sourcePath": sourcePath };

      try {
        const existed = await Document.exists(query);
        const document = await Document.findOneAndUpdate(query, update, { upsert: true, new: true }).exec();
        return { document: document as IDocument, isNew: !existed };
      } catch (err) {
        const isDuplicateKeyError = typeof err === "object" && err !== null && "code" in err && err.code === 11000;
        if (!isDuplicateKeyError) throw err;

        const document = await Document.findOneAndUpdate(query, update, { new: true }).exec();
        if (!document) throw err;
        return { document, isNew: false };
      }
    });
  }

  async findDocumentById(id: string | Types.ObjectId): Promise<IDocument | null> {
    return this.withConnection(async () => {
      return Document.findById(id).exec();
    });
  }

  async findDocumentsByEmailId(emailId: string | Types.ObjectId): Promise<IDocument[]> {
    return this.withConnection(async () => {
      return Document.find({ emailId }).sort({ createdAt: -1 }).exec();
    });
  }

  async deleteDocumentById(id: string | Types.ObjectId): Promise<void> {
    return this.withConnection(async () => {
      await Document.deleteOne({ _id: id }).exec();
    });
  }

  async createExtraction(input: CreateExtractionInput): Promise<IExtraction> {
    return this.withConnection(async () => {
      const extraction = await Extraction.create({
        documentId: input.documentId,
        extractionType: input.extractionType ?? "OCR_TO_JSON",
        provider: input.provider ?? "OLLAMA",
        status: input.status ?? "PENDING",
        attempts: input.attempts ?? 0,
        modelName: input.modelName,
        rawResponse: input.rawResponse,
        structuredData: input.structuredData ?? {},
        inputTextHash: input.inputTextHash,
        lastError: input.lastError ?? null,
        metadata: input.metadata ?? {},
      });

      return extraction;
    });
  }

  async findExtractionsByDocumentId(documentId: string | Types.ObjectId): Promise<IExtraction[]> {
    return this.withConnection(async () => {
      return Extraction.find({ documentId }).sort({ createdAt: -1 }).exec();
    });
  }

  async deleteExtractionsByDocumentId(documentId: string | Types.ObjectId): Promise<void> {
    return this.withConnection(async () => {
      await Extraction.deleteMany({ documentId }).exec();
    });
  }

  async createInvoice(input: CreateInvoiceInput): Promise<IInvoice> {
    return this.withConnection(async () => {
      const invoice = await Invoice.create({
        documentId: input.documentId,
        invoiceNumber: input.invoiceNumber,
        vendorName: input.vendorName,
        customerName: input.customerName,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        poNumber: input.poNumber,
        currency: input.currency,
        subtotal: input.subtotal,
        taxAmount: input.taxAmount,
        totalAmount: input.totalAmount,
        status: input.status ?? "NEW",
        extractedData: input.extractedData ?? {},
        metadata: input.metadata ?? {},
      });

      return invoice;
    });
  }

  async upsertInvoiceByDocumentId(input: CreateInvoiceInput): Promise<IInvoice | null> {
    return this.withConnection(async () => {
      return Invoice.findOneAndUpdate(
        { documentId: input.documentId },
        {
          $set: {
            invoiceNumber: input.invoiceNumber,
            vendorName: input.vendorName,
            customerName: input.customerName,
            invoiceDate: input.invoiceDate,
            dueDate: input.dueDate,
            poNumber: input.poNumber,
            currency: input.currency,
            subtotal: input.subtotal,
            taxAmount: input.taxAmount,
            totalAmount: input.totalAmount,
            status: input.status ?? "EXTRACTED",
            extractedData: input.extractedData ?? {},
            metadata: input.metadata ?? {},
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).exec();
    });
  }

  async findInvoicesByDocumentId(documentId: string | Types.ObjectId): Promise<IInvoice[]> {
    return this.withConnection(async () => {
      return Invoice.find({ documentId }).sort({ createdAt: -1 }).exec();
    });
  }

  async findInvoicesByIds(ids: Array<string | Types.ObjectId>): Promise<IInvoice[]> {
    return this.withConnection(async () => {
      return Invoice.find({ _id: { $in: ids } }).exec();
    });
  }

  async findInvoiceById(id: string | Types.ObjectId): Promise<IInvoice | null> {
    return this.withConnection(async () => {
      return Invoice.findById(id).exec();
    });
  }

  async updateInvoicePaymentStatus(
    id: string | Types.ObjectId,
    paymentStatus: IInvoice["paymentStatus"]
  ): Promise<IInvoice | null> {
    return this.withConnection(async () => {
      return Invoice.findByIdAndUpdate(id, { paymentStatus }, { new: true }).exec();
    });
  }

  async deleteInvoicesByDocumentId(documentId: string | Types.ObjectId): Promise<void> {
    return this.withConnection(async () => {
      await Invoice.deleteMany({ documentId }).exec();
    });
  }

  async createEmbedding(input: CreateEmbeddingInput): Promise<IEmbedding> {
    return this.withConnection(async () => {
      const embedding = await Embedding.create({
        invoiceId: input.invoiceId,
        documentId: input.documentId,
        chunkId: input.chunkId,
        chunkType: input.chunkType,
        embeddingModel: input.embeddingModel,
        embeddingVector: input.embeddingVector,
        sourceTextHash: input.sourceTextHash,
        status: input.status ?? "PENDING",
        metadata: input.metadata ?? {},
      });

      return embedding;
    });
  }

  async createChunk(input: CreateChunkInput) {
    return this.withConnection(async () => {
      const { Chunk } = await import("@/models/chunk.model");

      const chunk = await Chunk.create({
        invoiceId: input.invoiceId,
        documentId: input.documentId,
        chunkType: input.chunkType ?? "other",
        text: input.text,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        tokenCount: input.tokenCount,
        metadata: input.metadata ?? {},
      });

      return chunk;
    });
  }

  async findChunksByInvoiceId(invoiceId: string | Types.ObjectId) {
    return this.withConnection(async () => {
      const { Chunk } = await import("@/models/chunk.model");
      return Chunk.find({ invoiceId }).sort({ createdAt: -1 }).exec();
    });
  }

  async findChunksByDocumentId(documentId: string | Types.ObjectId) {
    return this.withConnection(async () => {
      const { Chunk } = await import("@/models/chunk.model");
      // Ascending order so index position matches the logical chunk order
      // (header, supplier, customer, line_items, taxes, payment, notes).
      return Chunk.find({ documentId }).sort({ createdAt: 1 }).exec();
    });
  }

  async findChunksByIds(ids: Array<string | Types.ObjectId>) {
    return this.withConnection(async () => {
      const { Chunk } = await import("@/models/chunk.model");
      return Chunk.find({ _id: { $in: ids } }).exec();
    });
  }

  async findEmbeddingsByInvoiceId(invoiceId: string | Types.ObjectId): Promise<IEmbedding[]> {
    return this.withConnection(async () => {
      return Embedding.find({ invoiceId }).sort({ createdAt: -1 }).exec();
    });
  }

  async findEmbeddingsByDocumentId(documentId: string | Types.ObjectId): Promise<IEmbedding[]> {
    return this.withConnection(async () => {
      return Embedding.find({ documentId }).sort({ createdAt: 1 }).exec();
    });
  }

  async deleteChunksByDocumentId(documentId: string | Types.ObjectId): Promise<void> {
    return this.withConnection(async () => {
      const { Chunk } = await import("@/models/chunk.model");
      await Chunk.deleteMany({ documentId }).exec();
    });
  }

  async deleteEmbeddingsByDocumentId(documentId: string | Types.ObjectId): Promise<void> {
    return this.withConnection(async () => {
      await Embedding.deleteMany({ documentId }).exec();
    });
  }

  async incrementEmailAttempts(
    id: string | Types.ObjectId,
    status: IEmail["status"],
    updates: Partial<IEmail> = {}
  ): Promise<IEmail | null> {
    return this.withConnection(async () => {
      return Email.findByIdAndUpdate(
        id,
        {
          $inc: { processingAttempts: 1 },
          status,
          ...updates,
        } as UpdateQuery<IEmail>,
        { new: true }
      ).exec();
    });
  }

  async incrementDocumentAttempts(
    id: string | Types.ObjectId,
    status: IDocument["status"],
    updates: Partial<IDocument> = {}
  ): Promise<IDocument | null> {
    return this.withConnection(async () => {
      return Document.findByIdAndUpdate(
        id,
        {
          $inc: { processingAttempts: 1 },
          status,
          ...updates,
        } as UpdateQuery<IDocument>,
        { new: true }
      ).exec();
    });
  }

  async incrementExtractionAttempts(
    id: string | Types.ObjectId,
    status: IExtraction["status"],
    updates: Partial<IExtraction> = {}
  ): Promise<IExtraction | null> {
    return this.withConnection(async () => {
      return Extraction.findByIdAndUpdate(
        id,
        {
          $inc: { attempts: 1 },
          status,
          ...updates,
        } as UpdateQuery<IExtraction>,
        { new: true }
      ).exec();
    });
  }

  async updateEmailStatus(
    id: string | Types.ObjectId,
    status: IEmail["status"],
    updates: Partial<IEmail> = {}
  ): Promise<IEmail | null> {
    return this.withConnection(async () => {
      return Email.findByIdAndUpdate(
        id,
        { status, ...updates } as UpdateQuery<IEmail>,
        { new: true }
      ).exec();
    });
  }

  async updateDocumentStatus(
    id: string | Types.ObjectId,
    status: IDocument["status"],
    updates: Partial<IDocument> = {}
  ): Promise<IDocument | null> {
    return this.withConnection(async () => {
      return Document.findByIdAndUpdate(
        id,
        { status, ...updates } as UpdateQuery<IDocument>,
        { new: true }
      ).exec();
    });
  }

  async updateExtractionStatus(
    id: string | Types.ObjectId,
    status: IExtraction["status"],
    updates: Partial<IExtraction> = {}
  ): Promise<IExtraction | null> {
    return this.withConnection(async () => {
      return Extraction.findByIdAndUpdate(
        id,
        { status, ...updates } as UpdateQuery<IExtraction>,
        { new: true }
      ).exec();
    });
  }

  async updateInvoiceStatus(
    id: string | Types.ObjectId,
    status: IInvoice["status"],
    updates: Partial<IInvoice> = {}
  ): Promise<IInvoice | null> {
    return this.withConnection(async () => {
      return Invoice.findByIdAndUpdate(
        id,
        { status, ...updates } as UpdateQuery<IInvoice>,
        { new: true }
      ).exec();
    });
  }

  async updateEmbeddingStatus(
    id: string | Types.ObjectId,
    status: IEmbedding["status"],
    updates: Partial<IEmbedding> = {}
  ): Promise<IEmbedding | null> {
    return this.withConnection(async () => {
      return Embedding.findByIdAndUpdate(
        id,
        { status, ...updates } as UpdateQuery<IEmbedding>,
        { new: true }
      ).exec();
    });
  }

  async listEmails(filter: Record<string, unknown> = {}): Promise<IEmail[]> {
    return this.withConnection(async () => {
      return Email.find(filter).sort({ receivedAt: -1 }).exec();
    });
  }

  async listDocuments(filter: Record<string, unknown> = {}): Promise<IDocument[]> {
    return this.withConnection(async () => {
      return Document.find(filter).sort({ createdAt: -1 }).exec();
    });
  }

  async listExtractions(filter: Record<string, unknown> = {}): Promise<IExtraction[]> {
    return this.withConnection(async () => {
      return Extraction.find(filter).sort({ createdAt: -1 }).exec();
    });
  }

  async listInvoices(filter: Record<string, unknown> = {}): Promise<IInvoice[]> {
    return this.withConnection(async () => {
      return Invoice.find(filter).sort({ createdAt: -1 }).exec();
    });
  }

  async listEmbeddings(filter: Record<string, unknown> = {}): Promise<IEmbedding[]> {
    return this.withConnection(async () => {
      return Embedding.find(filter).sort({ createdAt: -1 }).exec();
    });
  }

  async getDashboardStats(): Promise<DashboardStats> {
    return this.withConnection(async () => {
      const { Chunk } = await import("@/models/chunk.model");

      const [
        totalDocuments,
        totalInvoices,
        totalChunks,
        totalEmbeddings,
        processingSuccessCount,
        failedProcessingCount,
      ] = await Promise.all([
        Document.countDocuments().exec(),
        Invoice.countDocuments().exec(),
        Chunk.countDocuments().exec(),
        Embedding.countDocuments().exec(),
        Document.countDocuments({ status: "EXTRACTED" }).exec(),
        Document.countDocuments({ status: { $in: ["FAILED", "OCR_REQUIRED"] } }).exec(),
      ]);

      return {
        totalDocuments,
        totalInvoices,
        totalChunks,
        totalEmbeddings,
        averageChunksPerDocument: totalDocuments > 0 ? totalChunks / totalDocuments : 0,
        processingSuccessCount,
        failedProcessingCount,
      };
    });
  }

  async listDocumentsWithSummary(
    input: ListDocumentsSummaryInput = {}
  ): Promise<ListDocumentsSummaryResult> {
    return this.withConnection(async () => {
      const page = input.page && input.page > 0 ? Math.floor(input.page) : 1;
      const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 20;
      const skip = (page - 1) * limit;

      const match: Record<string, unknown> = {};
      if (input.status) match.status = input.status;

      const basePipeline: mongoose.PipelineStage[] = [
        { $match: match },
        {
          $lookup: {
            from: "invoices",
            localField: "_id",
            foreignField: "documentId",
            as: "invoice",
          },
        },
        { $unwind: { path: "$invoice", preserveNullAndEmptyArrays: true } },
      ];

      if (input.vendorName) {
        basePipeline.push({
          $match: { "invoice.vendorName": { $regex: input.vendorName, $options: "i" } },
        });
      }

      const countPipeline: mongoose.PipelineStage[] = [...basePipeline, { $count: "total" }];

      const dataPipeline: mongoose.PipelineStage[] = [
        ...basePipeline,
        {
          $lookup: {
            from: "chunks",
            localField: "_id",
            foreignField: "documentId",
            as: "chunks",
          },
        },
        {
          $project: {
            _id: 0,
            documentId: { $toString: "$_id" },
            filename: 1,
            status: 1,
            createdAt: 1,
            invoiceNumber: "$invoice.invoiceNumber",
            vendorName: "$invoice.vendorName",
            customerName: "$invoice.customerName",
            invoiceDate: "$invoice.invoiceDate",
            totalAmount: "$invoice.totalAmount",
            chunkCount: { $size: "$chunks" },
          },
        },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
      ];

      const [items, countResult] = await Promise.all([
        Document.aggregate<DocumentSummaryItem>(dataPipeline).exec(),
        Document.aggregate<{ total: number }>(countPipeline).exec(),
      ]);

      return {
        items,
        total: countResult[0]?.total ?? 0,
        page,
        limit,
      };
    });
  }
}

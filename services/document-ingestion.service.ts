import fs from "node:fs/promises";
import path from "node:path";
import type { Types } from "mongoose";
import { env } from "@/config/env";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { OllamaService } from "@/services/ollama.service";
import { DocumentQualityService } from "@/services/document-quality.service";
import { VisionExtractionService } from "@/services/vision-extraction.service";
import { DocumentClassifierService } from "@/services/document-classifier.service";
import type { DocumentClassification } from "@/schemas/document-classification.schema";
import { extractPdfText } from "@/utils/pdf-text-extractor";
import { isImageFile, isPdfFile } from "@/utils/document-file-type";
import { mapInvoiceExtractionToInvoiceFields } from "@/schemas/invoice-mapper";
import { InvoiceIndexingService } from "@/services/invoice-indexing.service";
import type { IDocument } from "@/models/document.model";
import type { IExtraction } from "@/models/extraction.model";
import type { IInvoice } from "@/models/invoice.model";

export interface ProcessLocalDocumentInput {
  sourcePath: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export class DocumentIngestionService {
  constructor(
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly ollamaService: OllamaService = new OllamaService(),
    private readonly indexingService: InvoiceIndexingService = new InvoiceIndexingService(repository),
    private readonly documentQualityService: DocumentQualityService = new DocumentQualityService(),
    private readonly visionExtractionService: VisionExtractionService = new VisionExtractionService(
      ollamaService
    ),
    private readonly documentClassifierService: DocumentClassifierService = new DocumentClassifierService(
      ollamaService
    )
  ) {}

  async processLocalDocument(input: ProcessLocalDocumentInput) {
    const absolutePath = path.resolve(input.sourcePath);
    const fileBuffer = await fs.readFile(absolutePath);
    const fileSize = fileBuffer.length;
    const fileName = path.basename(absolutePath);

    let text = "";
    let extractedText: string | undefined;
    let numPages: number | null = null;
    let extractionDurationMs = 0;
    let requiresOcr = false;
    let pdfExtractionError: string | null = null;
    const isPdf = isPdfFile(fileName);
    const isImage = isImageFile(fileName);

    if (isPdf) {
      let startTime = 0;
      try {
        startTime = Date.now();
        const pdfResult = await extractPdfText(fileBuffer);
        extractionDurationMs = Date.now() - startTime;

        const normalizedText = pdfResult.text.trim();
        numPages = pdfResult.numPages;

        console.info(JSON.stringify({
          event: "pdf-parse-debug",
          filename: fileName,
          fileSize,
          numPages,
          extractedCharacters: normalizedText.length,
          preview: normalizedText.slice(0, 300),
          durationMs: extractionDurationMs,
          status: normalizedText.length > 0 ? "PARSE_SUCCESS" : "PARSE_EMPTY",
        }));

        if (!normalizedText) {
          requiresOcr = true;
          pdfExtractionError = "PDF contained no extractable text.";
          console.info(JSON.stringify({
            event: "pdf-extraction",
            filename: fileName,
            fileSize,
            numPages,
            extractedCharacters: 0,
            preview: "",
            durationMs: extractionDurationMs,
            status: "OCR_REQUIRED",
          }));
        } else {
          text = normalizedText;
          extractedText = normalizedText;
          console.info(JSON.stringify({
            event: "pdf-extraction",
            filename: fileName,
            fileSize,
            numPages,
            extractedCharacters: normalizedText.length,
            preview: normalizedText.slice(0, 500),
            durationMs: extractionDurationMs,
            status: "SUCCEEDED",
          }));
        }
      } catch (err) {
        extractionDurationMs = Date.now() - startTime;
        requiresOcr = true;
        pdfExtractionError = err instanceof Error ? err.message : "Unknown PDF extraction error.";
        console.error(JSON.stringify({
          event: "pdf-extraction-failed",
          filename: fileName,
          fileSize,
          numPages,
          extractedCharacters: 0,
          preview: "",
          durationMs: extractionDurationMs,
          status: "OCR_REQUIRED",
          error: pdfExtractionError,
        }));
      }
    } else if (isImage) {
      // Raw photos/scans have no text layer to parse — go straight to vision
      // extraction below rather than decoding image bytes as UTF-8 "text".
      requiresOcr = true;
      numPages = 1;
      console.info(JSON.stringify({
        event: "image-ingestion",
        filename: fileName,
        fileSize,
        status: "VISION_REQUIRED",
      }));
    } else {
      text = fileBuffer.toString("utf-8");
      extractedText = text.trim();
    }

    let ocrSucceeded = false;

    const initialQuality = this.documentQualityService.assess(text, numPages ?? 1);

    if (initialQuality.score < env.DOCUMENT_QUALITY_THRESHOLD) {
      try {
        const recoveredText = await this.visionExtractionService.extractText(fileBuffer, isPdf);
        const recoveredQuality = this.documentQualityService.assess(recoveredText, numPages ?? 1);

        if (recoveredText && recoveredQuality.score > initialQuality.score) {
          text = recoveredText;
          ocrSucceeded = true;
        }
      } catch (err) {
        console.warn(
          "Vision-based text recovery failed:",
          err instanceof Error ? err.message : err
        );
      }
    }

    const email = await this.repository.createEmail({
      messageId: `local-${Date.now()}`,
      senderAddress: "local-source@example.com",
      subject: `Local document import: ${input.filename ?? path.basename(absolutePath)}`,
      metadata: { sourcePath: absolutePath, ...(input.metadata ?? {}) },
    });

    const document = await this.repository.createDocument({
      emailId: email._id,
      filename: input.filename ?? path.basename(absolutePath),
      documentType: "UNKNOWN",
      status: "EXTRACTING",
      extractedText: text,
      metadata: { sourcePath: absolutePath, ...(input.metadata ?? {}) },
    });

    const finalQuality = this.documentQualityService.assess(text, numPages ?? 1);

    if (finalQuality.score < env.DOCUMENT_QUALITY_THRESHOLD && !ocrSucceeded) {
      await this.repository.updateDocumentStatus(document._id, "OCR_REQUIRED", {
        lastError:
          "Document quality is too low for extraction. Install a working vision model or use a clearer scan.",
      });

      return {
        email,
        document,
        extraction: null,
        invoice: null,
        classification: null as DocumentClassification | null,
        message: "Document quality is too low for reliable extraction.",
      };
    }

    const classification = await this.documentClassifierService.classify(text);

    await this.repository.updateDocumentStatus(document._id, "EXTRACTED", {
      extractedText: text,
      documentType: classification.documentType,
      classificationConfidence: classification.confidence,
    });

    if (classification.documentType !== "INVOICE") {
      return {
        email,
        document,
        extraction: null,
        invoice: null,
        classification,
        message: `Document classified as ${classification.documentType}. Structured extraction is not yet supported for this document type.`,
      };
    }

    const extractionOutcome = await this.ollamaService.extractInvoiceData(text);

    const extraction = await this.repository.createExtraction({
      documentId: document._id,
      status: extractionOutcome.success ? "SUCCEEDED" : "FAILED",
      attempts: 1,
      modelName: env.OLLAMA_CHAT_MODEL,
      rawResponse: extractionOutcome.raw,
      structuredData: extractionOutcome.data ?? {},
      lastError: extractionOutcome.error ?? null,
      metadata: { source: "local-folder" },
    });

    if (!extractionOutcome.success || !extractionOutcome.data) {
      return {
        email,
        document,
        extraction,
        invoice: null,
        classification,
        message: "AI extraction failed. The raw model response was preserved on the extraction record for review.",
      };
    }

    const invoice = await this.repository.createInvoice({
      documentId: document._id,
      ...mapInvoiceExtractionToInvoiceFields(extractionOutcome.data),
      status: "EXTRACTED",
      metadata: { source: "local-folder" },
    });

    await this.indexingService.replaceChunksAndEmbeddings(
      document._id,
      invoice._id,
      extractionOutcome.data,
      { source: "local-folder" }
    );

    return {
      email,
      document,
      extraction,
      invoice,
      classification,
    };
  }

  /**
   * Re-runs AI extraction on an already-ingested document's stored text, upserts its
   * Invoice, and rebuilds its chunks/embeddings. Shared by /api/ai/extract and
   * /api/documents/:id/reindex so the logic exists in exactly one place.
   */
  async reextractDocument(documentId: Types.ObjectId | string): Promise<{
    success: boolean;
    document: IDocument | null;
    extraction: IExtraction | null;
    invoice: IInvoice | null;
    classification?: DocumentClassification | null;
    error?: string;
  }> {
    const document = await this.repository.findDocumentById(documentId);
    if (!document) {
      return { success: false, document: null, extraction: null, invoice: null, error: "Document not found" };
    }

    const textToExtract = document.extractedText ?? "Invoice details are unavailable.";

    const classification = await this.documentClassifierService.classify(textToExtract);

    await this.repository.updateDocumentStatus(document._id, "EXTRACTED", {
      documentType: classification.documentType,
      classificationConfidence: classification.confidence,
    });

    if (classification.documentType !== "INVOICE") {
      return {
        success: false,
        document,
        extraction: null,
        invoice: null,
        classification,
        error: `Document classified as ${classification.documentType}. Structured extraction is not yet supported for this document type.`,
      };
    }

    const outcome = await this.ollamaService.extractInvoiceData(textToExtract);

    const extraction = await this.repository.createExtraction({
      documentId: document._id,
      status: outcome.success ? "SUCCEEDED" : "FAILED",
      attempts: 1,
      modelName: env.OLLAMA_CHAT_MODEL,
      rawResponse: outcome.raw,
      structuredData: outcome.data ?? {},
      lastError: outcome.error ?? null,
      metadata: { source: "reindex" },
    });

    await this.repository.updateDocumentStatus(document._id, "EXTRACTED", {
      extractedText: textToExtract,
    });

    if (!outcome.success || !outcome.data) {
      return {
        success: false,
        document,
        extraction,
        invoice: null,
        classification,
        error: outcome.error ?? "AI extraction failed",
      };
    }

    const invoice = await this.repository.upsertInvoiceByDocumentId({
      documentId: document._id,
      ...mapInvoiceExtractionToInvoiceFields(outcome.data),
      status: "EXTRACTED",
      metadata: { source: "reindex" },
    });

    if (!invoice) {
      return {
        success: false,
        document,
        extraction,
        invoice: null,
        classification,
        error: "Failed to upsert invoice record.",
      };
    }

    await this.indexingService.replaceChunksAndEmbeddings(document._id, invoice._id, outcome.data, {
      source: "reindex",
    });

    return { success: true, document, extraction, invoice, classification };
  }
}

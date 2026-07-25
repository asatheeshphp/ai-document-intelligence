import { NextResponse, type NextRequest } from "next/server";
import { ProcessingRepository } from "@/repositories/processing.repository";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const repository = new ProcessingRepository();

    const document = await repository.findDocumentById(id);
    if (!document) {
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }

    const [invoices, extractions, chunks, embeddings] = await Promise.all([
      repository.findInvoicesByDocumentId(id),
      repository.findExtractionsByDocumentId(id),
      repository.findChunksByDocumentId(id),
      repository.findEmbeddingsByDocumentId(id),
    ]);

    const invoice = invoices[0] ?? null;
    const embeddingByChunkId = new Map(
      embeddings
        .filter((embedding) => embedding.chunkId)
        .map((embedding) => [embedding.chunkId!.toString(), embedding])
    );

    const chunkViews = chunks.map((chunk, index) => {
      const embedding = embeddingByChunkId.get(chunk._id.toString());
      return {
        id: chunk._id.toString(),
        index,
        chunkType: chunk.chunkType,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        metadata: chunk.metadata,
        embeddingDimension: embedding && Array.isArray(embedding.embeddingVector) ? embedding.embeddingVector.length : null,
        embeddingModel: embedding?.embeddingModel ?? null,
        embeddingStatus: embedding?.status ?? null,
        createdAt: chunk.createdAt,
      };
    });

    const timeline = extractions
      .map((extraction) => ({
        type: "extraction" as const,
        status: extraction.status,
        modelName: extraction.modelName,
        lastError: extraction.lastError,
        createdAt: extraction.createdAt,
      }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return NextResponse.json({
      success: true,
      document: {
        id: document._id.toString(),
        filename: document.filename,
        documentType: document.documentType,
        status: document.status,
        extractedText: document.extractedText,
        metadata: document.metadata,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
      invoice: invoice
        ? {
            id: invoice._id.toString(),
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            customerName: invoice.customerName,
            invoiceDate: invoice.invoiceDate,
            dueDate: invoice.dueDate,
            poNumber: invoice.poNumber,
            currency: invoice.currency,
            subtotal: invoice.subtotal,
            taxAmount: invoice.taxAmount,
            totalAmount: invoice.totalAmount,
            status: invoice.status,
            extractedData: invoice.extractedData,
            metadata: invoice.metadata,
          }
        : null,
      chunks: chunkViews,
      embeddingsSummary: {
        totalEmbeddings: embeddings.length,
        embeddingModel: embeddings[0]?.embeddingModel ?? null,
        dimension: embeddings[0] && Array.isArray(embeddings[0].embeddingVector) ? embeddings[0].embeddingVector.length : null,
      },
      timeline,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown document detail error",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const repository = new ProcessingRepository();

    const document = await repository.findDocumentById(id);
    if (!document) {
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }

    await repository.deleteEmbeddingsByDocumentId(id);
    await repository.deleteChunksByDocumentId(id);
    await repository.deleteInvoicesByDocumentId(id);
    await repository.deleteExtractionsByDocumentId(id);
    await repository.deleteDocumentById(id);

    return NextResponse.json({ success: true, documentId: id });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown document delete error",
      },
      { status: 500 }
    );
  }
}

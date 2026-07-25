import { NextResponse } from "next/server";
import { ProcessingRepository } from "@/repositories/processing.repository";

export async function GET() {
  return POST();
}

export async function POST() {
  try {
    const repository = new ProcessingRepository();

    const email = await repository.createEmail({
      messageId: `msg-${Date.now()}`,
      senderAddress: "invoice@example.com",
      subject: "Invoice processing test",
      metadata: { source: "api-test" },
    });

    const document = await repository.createDocument({
      emailId: email._id,
      filename: "invoice.pdf",
      documentType: "INVOICE",
      status: "DOWNLOADED",
      metadata: { source: "api-test" },
    });

    const extraction = await repository.createExtraction({
      documentId: document._id,
      status: "SUCCEEDED",
      attempts: 1,
      modelName: "qwen2.5:1.5b",
      structuredData: { invoiceNumber: "INV-1001" },
    });

    const invoice = await repository.createInvoice({
      documentId: document._id,
      invoiceNumber: "INV-1001",
      vendorName: "Contoso",
      currency: "USD",
      totalAmount: 1250,
      status: "EXTRACTED",
      extractedData: { invoiceNumber: "INV-1001" },
    });

    await repository.createEmbedding({
      invoiceId: invoice._id,
      documentId: document._id,
      embeddingModel: "nomic-embed-text",
      embeddingVector: [0.1, 0.2, 0.3],
      status: "COMPLETED",
    });

    const relatedDocuments = await repository.findDocumentsByEmailId(email._id);
    const relatedExtractions = await repository.findExtractionsByDocumentId(document._id);

    return NextResponse.json({
      success: true,
      email: { id: email._id.toString(), messageId: email.messageId },
      document: { id: document._id.toString(), filename: document.filename },
      extraction: { id: extraction._id.toString(), status: extraction.status },
      invoice: { id: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber },
      relatedDocuments: relatedDocuments.length,
      relatedExtractions: relatedExtractions.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown processing error",
      },
      { status: 500 }
    );
  }
}

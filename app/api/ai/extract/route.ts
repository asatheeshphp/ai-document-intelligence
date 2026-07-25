import { NextResponse } from "next/server";
import { DocumentIngestionService } from "@/services/document-ingestion.service";

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: "Use POST with a JSON body containing documentId to run AI extraction.",
    },
    { status: 405 }
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const documentId = body?.documentId as string | undefined;

    if (!documentId) {
      return NextResponse.json(
        { success: false, error: "documentId is required" },
        { status: 400 }
      );
    }

    const service = new DocumentIngestionService();
    const outcome = await service.reextractDocument(documentId);

    if (!outcome.document) {
      return NextResponse.json(
        { success: false, error: outcome.error ?? "Document not found" },
        { status: 404 }
      );
    }

    if (!outcome.success) {
      return NextResponse.json(
        {
          success: false,
          documentId: outcome.document._id.toString(),
          extractionId: outcome.extraction?._id.toString(),
          error: outcome.error ?? "AI extraction failed",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      documentId: outcome.document._id.toString(),
      extractionId: outcome.extraction?._id.toString(),
      invoiceId: outcome.invoice?._id.toString(),
      result: outcome.invoice?.extractedData,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown AI extraction error",
      },
      { status: 500 }
    );
  }
}

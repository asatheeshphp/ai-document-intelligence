import { NextResponse, type NextRequest } from "next/server";
import { DocumentIngestionService } from "@/services/document-ingestion.service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const service = new DocumentIngestionService();
    const outcome = await service.processDuplicateAnyway(id);

    if (!outcome.success) {
      return NextResponse.json(
        {
          success: false,
          documentId: outcome.document?._id.toString(),
          error: outcome.error ?? "Failed to process document",
        },
        { status: outcome.document ? 409 : 404 }
      );
    }

    return NextResponse.json({
      success: true,
      documentId: outcome.document?._id.toString(),
      invoiceId: outcome.invoice?._id.toString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown process-anyway error",
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import path from "node:path";
import { DocumentIngestionService } from "@/services/document-ingestion.service";

export async function POST() {
  try {
    const samplePath = path.resolve("data/samples/sample-invoice.pdf");
    const service = new DocumentIngestionService();
    const result = await service.processLocalDocument({
      sourcePath: samplePath,
      filename: "sample-invoice.pdf",
      metadata: { sample: true },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown sample ingestion error",
      },
      { status: 500 }
    );
  }
}

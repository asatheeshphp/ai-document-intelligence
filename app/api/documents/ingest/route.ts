import { NextResponse } from "next/server";
import { DocumentIngestionService } from "@/services/document-ingestion.service";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sourcePath = body?.sourcePath as string | undefined;
    const filename = body?.filename as string | undefined;

    if (!sourcePath) {
      return NextResponse.json(
        { success: false, error: "sourcePath is required" },
        { status: 400 }
      );
    }

    const service = new DocumentIngestionService();
    const result = await service.processLocalDocument({ sourcePath, filename });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown ingestion error",
      },
      { status: 500 }
    );
  }
}

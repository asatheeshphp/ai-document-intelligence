import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { DocumentIngestionService } from "@/services/document-ingestion.service";

export async function GET() {
  try {
    const folderPath = path.resolve("data/samples");
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map((entry) => entry.name)
      .sort();

    if (files.length === 0) {
      return NextResponse.json({ success: false, error: "No PDF invoices found in data/samples" }, { status: 404 });
    }

    const latestFile = files[files.length - 1];
    const service = new DocumentIngestionService();
    const result = await service.processLocalDocument({
      sourcePath: path.join(folderPath, latestFile),
      filename: latestFile,
      metadata: { sourceFolder: folderPath },
    });

    return NextResponse.json({ success: true, latestFile, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown latest invoice processing error",
      },
      { status: 500 }
    );
  }
}

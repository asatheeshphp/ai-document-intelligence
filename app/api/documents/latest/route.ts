import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { DocumentIngestionService } from "@/services/document-ingestion.service";
import { isImageFile, isPdfFile } from "@/utils/document-file-type";

export async function GET() {
  try {
    const folderPath = path.resolve("data/samples");
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const candidateNames = entries
      .filter((entry) => entry.isFile() && (isPdfFile(entry.name) || isImageFile(entry.name)))
      .map((entry) => entry.name);

    if (candidateNames.length === 0) {
      return NextResponse.json(
        { success: false, error: "No PDF or image invoices found in data/samples" },
        { status: 404 }
      );
    }

    // Sorting filenames alphabetically picked whichever name sorted last, not whichever
    // file actually arrived most recently -- e.g. an email attachment named
    // "62202-invoice.pdf" sorts before "8.invoice.pdf" alphabetically even though it's
    // newer. Sort by actual file modification time instead, so "latest" means latest.
    const filesWithMtime = await Promise.all(
      candidateNames.map(async (name) => {
        const stats = await fs.stat(path.join(folderPath, name));
        return { name, mtimeMs: stats.mtimeMs };
      })
    );
    filesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const latestFile = filesWithMtime[0].name;
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

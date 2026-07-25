import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { renderPdfPagesToImages } from "@/utils/pdf-image-renderer";
import { extractPdfText } from "@/utils/pdf-text-extractor";

const SAMPLE_PDF = path.resolve("data/samples/4.invoice_01_abc_technologies.pdf");

describe("renderPdfPagesToImages", () => {
  it("renders one PNG image buffer per page", async () => {
    const buffer = await fs.readFile(SAMPLE_PDF);
    const { numPages } = await extractPdfText(buffer);

    const images = await renderPdfPagesToImages(buffer);

    expect(images).toHaveLength(numPages);
    for (const image of images) {
      expect(image.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
  });
});

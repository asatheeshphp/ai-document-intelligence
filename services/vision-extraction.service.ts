import { renderPdfPagesToImages } from "@/utils/pdf-image-renderer";
import { OllamaService } from "@/services/ollama.service";

export class VisionExtractionService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  /**
   * `isPdf` selects how `fileBuffer` is turned into page images: PDFs are rendered
   * page-by-page via pdfjs/canvas, while a raw photo/scan (JPG, PNG, ...) is already
   * a single page image and is passed straight through, base64-encoded, with no
   * PDF-specific decoding.
   */
  async extractText(fileBuffer: Buffer, isPdf: boolean): Promise<string> {
    const base64Images = isPdf
      ? (await renderPdfPagesToImages(fileBuffer)).map((image) => image.toString("base64"))
      : [fileBuffer.toString("base64")];

    return this.ollamaService.visionExtractText(base64Images);
  }
}

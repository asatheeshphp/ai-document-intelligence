import { renderPdfPagesToImages } from "@/utils/pdf-image-renderer";
import { OllamaService } from "@/services/ollama.service";

export class VisionExtractionService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async extractText(pdfBuffer: Buffer): Promise<string> {
    const images = await renderPdfPagesToImages(pdfBuffer);
    const base64Images = images.map((image) => image.toString("base64"));
    return this.ollamaService.visionExtractText(base64Images);
  }
}

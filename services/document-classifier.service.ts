import { OllamaService } from "@/services/ollama.service";
import type { DocumentClassification } from "@/schemas/document-classification.schema";

export class DocumentClassifierService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async classify(text: string): Promise<DocumentClassification> {
    const outcome = await this.ollamaService.classifyDocument(text);

    if (!outcome.success || !outcome.data) {
      return { documentType: "OTHER", confidence: 0 };
    }

    return outcome.data;
  }
}

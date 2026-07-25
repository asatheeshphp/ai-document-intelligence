import { describe, it, expect, vi } from "vitest";
import { DocumentClassifierService } from "@/services/document-classifier.service";
import type { OllamaService } from "@/services/ollama.service";

function fakeOllamaService(outcome: {
  success: boolean;
  data: { documentType: string; confidence: number } | null;
}): OllamaService {
  return {
    classifyDocument: vi.fn().mockResolvedValue({ raw: "", ...outcome }),
  } as unknown as OllamaService;
}

describe("DocumentClassifierService", () => {
  it("returns the model's classification when successful", async () => {
    const ollama = fakeOllamaService({
      success: true,
      data: { documentType: "INVOICE", confidence: 0.9 },
    });
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("some invoice text");

    expect(result).toEqual({ documentType: "INVOICE", confidence: 0.9 });
  });

  it("falls back to OTHER with zero confidence when classification fails", async () => {
    const ollama = fakeOllamaService({ success: false, data: null });
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("garbled text");

    expect(result).toEqual({ documentType: "OTHER", confidence: 0 });
  });
});

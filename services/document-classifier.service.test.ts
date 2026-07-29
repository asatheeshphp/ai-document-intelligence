import { describe, it, expect, vi } from "vitest";
import { DocumentClassifierService } from "@/services/document-classifier.service";
import type { OllamaService } from "@/services/ollama.service";

function fakeOllamaServiceWithSequence(
  outcomes: Array<{ success: boolean; data: { documentType: string; confidence: number } | null }>
): OllamaService {
  const classifyDocument = vi.fn();
  for (const outcome of outcomes) {
    classifyDocument.mockResolvedValueOnce({ raw: "", ...outcome });
  }
  return { classifyDocument } as unknown as OllamaService;
}

function fakeOllamaService(outcome: {
  success: boolean;
  data: { documentType: string; confidence: number } | null;
}): OllamaService {
  return {
    classifyDocument: vi.fn().mockResolvedValue({ raw: "", ...outcome }),
  } as unknown as OllamaService;
}

describe("DocumentClassifierService", () => {
  it("returns the model's classification when every attempt agrees", async () => {
    const ollama = fakeOllamaService({
      success: true,
      data: { documentType: "INVOICE", confidence: 0.9 },
    });
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("some invoice text");

    expect(result).toEqual({ documentType: "INVOICE", confidence: 0.9 });
    expect(ollama.classifyDocument).toHaveBeenCalledTimes(3);
  });

  it("falls back to NOT_INVOICE with zero confidence when every attempt fails", async () => {
    const ollama = fakeOllamaService({ success: false, data: null });
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("garbled text");

    expect(result).toEqual({ documentType: "NOT_INVOICE", confidence: 0 });
  });

  it("takes the majority vote when attempts disagree (2 INVOICE vs 1 NOT_INVOICE)", async () => {
    // Mirrors the confirmed live failure mode: a model can answer NOT_INVOICE on one
    // attempt despite the document genuinely being an invoice on the other attempts.
    const ollama = fakeOllamaServiceWithSequence([
      { success: true, data: { documentType: "INVOICE", confidence: 1 } },
      { success: true, data: { documentType: "NOT_INVOICE", confidence: 1 } },
      { success: true, data: { documentType: "INVOICE", confidence: 0.8 } },
    ]);
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("borderline utility bill text");

    expect(result.documentType).toBe("INVOICE");
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("counts a failed individual attempt as a NOT_INVOICE vote rather than aborting", async () => {
    const ollama = fakeOllamaServiceWithSequence([
      { success: true, data: { documentType: "INVOICE", confidence: 0.9 } },
      { success: false, data: null },
      { success: true, data: { documentType: "INVOICE", confidence: 0.7 } },
    ]);
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("some invoice text");

    expect(result.documentType).toBe("INVOICE");
    expect(result.confidence).toBeCloseTo(0.8);
  });
});

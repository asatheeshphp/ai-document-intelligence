import { describe, it, expect, vi } from "vitest";
import { VisionExtractionService } from "@/services/vision-extraction.service";
import type { OllamaService } from "@/services/ollama.service";

vi.mock("@/utils/pdf-image-renderer", () => ({
  renderPdfPagesToImages: vi.fn().mockResolvedValue([Buffer.from("page1"), Buffer.from("page2")]),
}));

function fakeOllamaService(text: string): OllamaService {
  return {
    visionExtractText: vi.fn().mockResolvedValue(text),
  } as unknown as OllamaService;
}

describe("VisionExtractionService", () => {
  it("renders pages, base64-encodes them, and passes them to visionExtractText", async () => {
    const ollama = fakeOllamaService("Recovered invoice text");
    const service = new VisionExtractionService(ollama);

    const result = await service.extractText(Buffer.from("fake pdf bytes"));

    expect(result).toBe("Recovered invoice text");
    expect(ollama.visionExtractText).toHaveBeenCalledWith([
      Buffer.from("page1").toString("base64"),
      Buffer.from("page2").toString("base64"),
    ]);
  });
});

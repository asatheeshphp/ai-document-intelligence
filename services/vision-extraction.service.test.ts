import { describe, it, expect, vi } from "vitest";
import { VisionExtractionService } from "@/services/vision-extraction.service";
import { renderPdfPagesToImages } from "@/utils/pdf-image-renderer";
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
  it("renders PDF pages, base64-encodes them, and passes them to visionExtractText when isPdf=true", async () => {
    const ollama = fakeOllamaService("Recovered invoice text");
    const service = new VisionExtractionService(ollama);

    const result = await service.extractText(Buffer.from("fake pdf bytes"), true);

    expect(result).toBe("Recovered invoice text");
    expect(ollama.visionExtractText).toHaveBeenCalledWith([
      Buffer.from("page1").toString("base64"),
      Buffer.from("page2").toString("base64"),
    ]);
  });

  it("passes a raw image buffer straight through as a single base64 page when isPdf=false", async () => {
    vi.mocked(renderPdfPagesToImages).mockClear();
    const ollama = fakeOllamaService("Recovered invoice text from photo");
    const service = new VisionExtractionService(ollama);

    const imageBuffer = Buffer.from("fake jpeg bytes");
    const result = await service.extractText(imageBuffer, false);

    expect(result).toBe("Recovered invoice text from photo");
    expect(renderPdfPagesToImages).not.toHaveBeenCalled();
    expect(ollama.visionExtractText).toHaveBeenCalledWith([imageBuffer.toString("base64")]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { OllamaService } from "@/services/ollama.service";
import { env } from "@/config/env";

vi.mock("axios");

describe("OllamaService.visionExtractText", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("posts images to /api/chat with the configured vision model and returns trimmed text", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: "  Transcribed invoice text  " } },
    });

    const service = new OllamaService();
    const result = await service.visionExtractText(["base64imagedata"]);

    expect(result).toBe("Transcribed invoice text");

    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [
      string,
      { model: string; messages: { images: string[] }[] },
    ];
    expect(url).toBe(`${env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`);
    expect(body.model).toBe(env.OLLAMA_VISION_MODEL);
    expect(body.messages[0].images).toEqual(["base64imagedata"]);
  });

  it("accepts a model override", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { message: { content: "text" } } });

    const service = new OllamaService();
    await service.visionExtractText(["img"], "custom-vision-model:7b");

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, { model: string }];
    expect(body.model).toBe("custom-vision-model:7b");
  });

  it("scales the request timeout with the number of images, not a fixed ceiling", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { message: { content: "text" } } });

    const service = new OllamaService();
    await service.visionExtractText(["page1"]);
    const [, , singlePageConfig] = vi.mocked(axios.post).mock.calls[0] as [string, unknown, { timeout: number }];

    vi.mocked(axios.post).mockClear();
    await service.visionExtractText(["page1", "page2", "page3"]);
    const [, , threePageConfig] = vi.mocked(axios.post).mock.calls[0] as [string, unknown, { timeout: number }];

    expect(threePageConfig.timeout).toBe(singlePageConfig.timeout * 3);
  });
});

describe("OllamaService.classifyDocument", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("parses a valid schema-constrained classification response", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: JSON.stringify({ documentType: "INVOICE", confidence: 0.88 }) } },
    });

    const service = new OllamaService();
    const outcome = await service.classifyDocument("some invoice text");

    expect(outcome.success).toBe(true);
    expect(outcome.data).toEqual({ documentType: "INVOICE", confidence: 0.88 });
  });

  it("returns a failure outcome on invalid JSON", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: "not json" } },
    });

    const service = new OllamaService();
    const outcome = await service.classifyDocument("some text");

    expect(outcome.success).toBe(false);
    expect(outcome.data).toBeNull();
  });
});

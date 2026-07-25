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

    const [url, body] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe(`${env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`);
    expect(body.model).toBe(env.OLLAMA_VISION_MODEL);
    expect(body.messages[0].images).toEqual(["base64imagedata"]);
  });

  it("accepts a model override", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { message: { content: "text" } } });

    const service = new OllamaService();
    await service.visionExtractText(["img"], "custom-vision-model:7b");

    const [, body] = vi.mocked(axios.post).mock.calls[0];
    expect(body.model).toBe("custom-vision-model:7b");
  });
});

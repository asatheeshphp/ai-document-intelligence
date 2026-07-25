import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { SiglipService } from "@/services/siglip.service";
import { env } from "@/config/env";

vi.mock("axios");

describe("SiglipService.embedText", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("posts text to /embed-text and returns the embedding vector", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { embedding: [0.1, 0.2, 0.3], dimension: 3 },
    });

    const service = new SiglipService();
    const result = await service.embedText("hello world");

    expect(result).toEqual([0.1, 0.2, 0.3]);

    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [string, { text: string }];
    expect(url).toBe(`${env.SIGLIP_SERVICE_URL.replace(/\/$/, "")}/embed-text`);
    expect(body.text).toBe("hello world");
  });

  it("returns an empty array if the response has no embedding field", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: {} });

    const service = new SiglipService();
    const result = await service.embedText("anything");

    expect(result).toEqual([]);
  });
});

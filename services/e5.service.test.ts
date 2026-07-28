import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { E5Service } from "@/services/e5.service";
import { env } from "@/config/env";

vi.mock("axios");

describe("E5Service.embedText", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("posts text and kind to /embed-text and returns the embedding vector", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { embedding: [0.1, 0.2, 0.3], dimension: 3 },
    });

    const service = new E5Service();
    const result = await service.embedText("hello world", "passage");

    expect(result).toEqual([0.1, 0.2, 0.3]);

    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [string, { text: string; kind: string }];
    expect(url).toBe(`${env.E5_SERVICE_URL.replace(/\/$/, "")}/embed-text`);
    expect(body.text).toBe("hello world");
    expect(body.kind).toBe("passage");
  });

  it("sends kind: query for search queries", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { embedding: [0.4, 0.5], dimension: 2 } });

    const service = new E5Service();
    await service.embedText("find the invoice", "query");

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, { kind: string }];
    expect(body.kind).toBe("query");
  });

  it("returns an empty array if the response has no embedding field", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: {} });

    const service = new E5Service();
    const result = await service.embedText("anything", "passage");

    expect(result).toEqual([]);
  });
});

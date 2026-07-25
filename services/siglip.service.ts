import axios from "axios";
import { env } from "@/config/env";

export class SiglipService {
  async embedText(text: string): Promise<number[]> {
    const baseUrl = env.SIGLIP_SERVICE_URL.replace(/\/$/, "");

    const response = await axios.post(
      `${baseUrl}/embed-text`,
      { text },
      {
        // SigLIP2 text-embedding calls are a single forward pass over a short input —
        // much faster than Ollama's chat-completion calls, but still allow real headroom
        // for CPU-only inference and first-request model warmup.
        timeout: 30000,
      }
    );

    return response.data?.embedding ?? [];
  }
}

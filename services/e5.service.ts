import axios from "axios";
import { env } from "@/config/env";

export type E5EmbedKind = "query" | "passage";

export class E5Service {
  // multilingual-e5-base was trained with asymmetric "query: " / "passage: " prefixes --
  // queries and the documents they're matched against are embedded differently on
  // purpose. Required (no default) so every call site states which one it means.
  async embedText(text: string, kind: E5EmbedKind): Promise<number[]> {
    const baseUrl = env.E5_SERVICE_URL.replace(/\/$/, "");

    try {
      const response = await axios.post(
        `${baseUrl}/embed-text`,
        { text, kind },
        {
          timeout: 30000,
        }
      );

      return response.data?.embedding ?? [];
    } catch (error) {
      // The sidecar is a separate process (not managed or auto-restarted by this app --
      // see e5-service/README.md), so it being down is an operational fact, not a bug.
      // Left as the raw axios error, this surfaces as a bare "connect ECONNREFUSED
      // 127.0.0.1:8001" with no indication of what's actually missing or how to fix it.
      if (axios.isAxiosError(error) && (error.code === "ECONNREFUSED" || !error.response)) {
        throw new Error(
          `E5 embedding service is unreachable at ${baseUrl}. It's a separate process that ` +
            `must be started manually: cd e5-service && uvicorn main:app --host 127.0.0.1 --port 8001 ` +
            `(see e5-service/README.md).`
        );
      }
      throw error;
    }
  }
}

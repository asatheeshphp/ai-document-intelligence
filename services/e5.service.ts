import axios from "axios";
import { env } from "@/config/env";

export type E5EmbedKind = "query" | "passage";

export class E5Service {
  // multilingual-e5-base was trained with asymmetric "query: " / "passage: " prefixes --
  // queries and the documents they're matched against are embedded differently on
  // purpose. Required (no default) so every call site states which one it means.
  async embedText(text: string, kind: E5EmbedKind): Promise<number[]> {
    const baseUrl = env.E5_SERVICE_URL.replace(/\/$/, "");

    const response = await axios.post(
      `${baseUrl}/embed-text`,
      { text, kind },
      {
        timeout: 30000,
      }
    );

    return response.data?.embedding ?? [];
  }
}

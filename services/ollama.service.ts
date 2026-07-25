import axios from "axios";
import { env } from "@/config/env";
import {
  InvoiceExtractionSchema,
  InvoiceExtractionJsonSchema,
  type InvoiceExtraction,
} from "@/schemas/invoice.schema";

function buildExtractionPrompt(documentText: string): string {
  return `You are an expert invoice data extraction assistant. Extract ALL available information from the invoice text below into the required JSON structure.

Rules:
- If a value cannot be found in the text, use null for scalar fields or an empty array for list fields. Never guess or invent a value.
- Extract every line item and every tax line (GST, CGST, SGST, IGST, VAT, sales tax, duty, etc.), and every reference number you can find.
- The "taxes" array must contain ONLY actual tax/levy line items. Never include the subtotal, discount, shipping charge, or grand/total payable amount as a "taxes" entry — those belong solely in "totals".
- Ignore any stray formatting artifacts in the source text (e.g. leftover HTML-like tags such as "<b>" or "</b>") — treat them as if they were not there and extract only the real label and value.
- Put any clearly labeled invoice data that doesn't fit the named fields into "additionalFields" as key-value pairs (e.g. project code, department, delivery date). Leave it as an empty object if there is nothing extra.
- Numbers must be plain numbers, without currency symbols or thousands separators.

Invoice text:
"""
${documentText}
"""`;
}

export interface InvoiceExtractionOutcome {
  raw: string;
  success: boolean;
  data: InvoiceExtraction | null;
  error?: string;
}

export class OllamaService {
  async extractInvoiceData(
    documentText: string,
    model: string = env.OLLAMA_CHAT_MODEL
  ): Promise<InvoiceExtractionOutcome> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");
    const prompt = buildExtractionPrompt(documentText);

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        format: InvoiceExtractionJsonSchema,
        options: { temperature: 0.1 },
      },
      {
        // Schema-constrained decoding over the full nested invoice schema is slow on
        // CPU-only Ollama regardless of input length (measured ~108s on an 862-char
        // invoice) — 120s left too little headroom against normal run-to-run variance.
        timeout: 240000,
      }
    );

    const raw = String(response.data?.message?.content ?? "");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { raw, success: false, data: null, error: "Model response was not valid JSON." };
    }

    const result = InvoiceExtractionSchema.safeParse(parsedJson);
    if (!result.success) {
      return { raw, success: false, data: null, error: result.error.message };
    }

    return { raw, success: true, data: result.data };
  }

  async embedText(text: string, model: string = env.OLLAMA_EMBED_MODEL): Promise<number[]> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");

    const response = await axios.post(
      `${baseUrl}/api/embeddings`,
      {
        model,
        prompt: text,
      },
      {
        timeout: 120000,
      }
    );

    return response.data?.embedding ?? [];
  }

  async chatCompletion(prompt: string, model: string = env.OLLAMA_CHAT_MODEL): Promise<string> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.1 },
      },
      {
        // Unlike extractInvoiceData, this has no `format` schema — free-text generation
        // isn't bottlenecked by schema-constrained decoding, so 60s is ample headroom.
        timeout: 60000,
      }
    );

    return String(response.data?.message?.content ?? "").trim();
  }

  async visionExtractText(images: string[], model: string = env.OLLAMA_VISION_MODEL): Promise<string> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content:
              "Transcribe all readable text from these document page images, in reading order, exactly as it appears. Do not summarize, translate, or add commentary — output only the transcribed text.",
            images,
          },
        ],
        options: { temperature: 0.1 },
      },
      {
        // Vision models processing page images run noticeably slower than the 1.5B
        // text-only chat model on CPU-only Ollama, similar in spirit to why
        // extractInvoiceData needs 240000ms for schema-constrained decoding — 180s
        // leaves headroom for multi-page image input without the schema-decoding cost.
        timeout: 180000,
      }
    );

    return String(response.data?.message?.content ?? "").trim();
  }
}

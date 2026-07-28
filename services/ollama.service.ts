import axios from "axios";
import { env } from "@/config/env";
import {
  InvoiceExtractionSchema,
  InvoiceExtractionJsonSchema,
  type InvoiceExtraction,
} from "@/schemas/invoice.schema";
import {
  DocumentClassificationSchema,
  DocumentClassificationJsonSchema,
  type DocumentClassification,
} from "@/schemas/document-classification.schema";

// Measured against this CPU-only Ollama setup: qwen2.5vl:7b took ~308s to transcribe
// one real invoice photo. Multiplying by image count covers multi-page PDFs sent as
// multiple images in a single /api/chat call, with headroom over the measured value.
const VISION_TIMEOUT_PER_IMAGE_MS = 400000;

// Small chat models (e.g. qwen2.5:1.5b) don't reliably follow the prompt's instruction
// to leave "address.raw" null when no real address is present — observed in practice
// dumping the entire invoice body (line items, totals, remarks) into it instead. A real
// postal address is short and rarely spans more than one or two lines, so anything
// implausibly long or multi-line is treated as a body-dump and nulled out rather than
// trusted, regardless of what the model returned.
const MAX_PLAUSIBLE_ADDRESS_LENGTH = 120;

function sanitizeAddressRaw(raw: string | null): string | null {
  if (!raw) return raw;
  const newlineCount = raw.match(/\n/g)?.length ?? 0;
  const looksLikeBodyDump = raw.length > MAX_PLAUSIBLE_ADDRESS_LENGTH || newlineCount >= 2;
  return looksLikeBodyDump ? null : raw;
}

// The prompt's tax rule used to list example tax type names (GST, CGST, SGST, ...) and
// qwen2.5:1.5b treated that list as a checklist to always fill in, producing a hallucinated
// entry per named type with no rate and either no amount or a zero amount, regardless of
// whether that tax actually appears on the invoice. These carry no real information but
// still get embedded and searched, and — like short template-y invoice text generally —
// can score deceptively high in SigLIP2's similarity space, surfacing an unrelated
// invoice's noise above genuinely relevant content. Prompt wording alone didn't fully
// stop it (same lesson as sanitizeAddressRaw above), so drop any tax entry with no rate
// and no real (non-zero) amount — there's nothing there worth keeping or searching on.
function isMeaninglessTaxEntry(tax: InvoiceExtraction["taxes"][number]): boolean {
  const hasRate = tax.rate != null;
  const hasRealAmount = tax.amount != null && tax.amount !== 0;
  return !hasRate && !hasRealAmount;
}

function sanitizeInvoiceExtraction(data: InvoiceExtraction): InvoiceExtraction {
  return {
    ...data,
    supplier: { ...data.supplier, address: { ...data.supplier.address, raw: sanitizeAddressRaw(data.supplier.address.raw) } },
    customer: { ...data.customer, address: { ...data.customer.address, raw: sanitizeAddressRaw(data.customer.address.raw) } },
    shipping: { ...data.shipping, address: { ...data.shipping.address, raw: sanitizeAddressRaw(data.shipping.address.raw) } },
    taxes: data.taxes.filter((tax) => !isMeaninglessTaxEntry(tax)),
  };
}

function buildExtractionPrompt(documentText: string): string {
  return `You are an expert invoice data extraction assistant. Extract ALL available information from the invoice text below into the required JSON structure.

Rules:
- If a value cannot be found in the text, use null for scalar fields or an empty array for list fields. Never guess or invent a value.
- Extract every line item and every reference number you can find.
- The "taxes" array must contain ONLY tax/levy lines that actually appear, printed, in the invoice text below — GST, CGST, SGST, IGST, VAT, sales tax, and duty are only examples of what a tax line might be called, NOT a checklist to fill in. Do not add an entry for a tax type just because it's a common one; a tax type not printed anywhere in the text must not appear in "taxes" at all. Never include the subtotal, discount, shipping charge, or grand/total payable amount as a "taxes" entry — those belong solely in "totals".
- Ignore any stray formatting artifacts in the source text (e.g. leftover HTML-like tags such as "<b>" or "</b>") — treat them as if they were not there and extract only the real label and value.
- Put any clearly labeled invoice data that doesn't fit the named fields into "additionalFields" as key-value pairs (e.g. project code, department, delivery date). Leave it as an empty object if there is nothing extra.
- Numbers must be plain numbers, without currency symbols or thousands separators.
- An "address.raw" field must contain ONLY that party's physical postal address lines (street, city, state, postal code, country) — nothing else. Never copy invoice numbers, dates, GSTIN/tax IDs, vehicle/trip/driver details, charge/line-item tables, totals, delivery remarks, or any other section of the document into an address field, even if no true address is present in the text. If no physical address can be found for a party, set "address.raw" to null rather than filling it with unrelated document text.

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

function buildClassificationPrompt(documentText: string): string {
  return `Classify the document type of the text below into exactly one of: INVOICE, RECEIPT, PURCHASE_ORDER, CONTRACT, RESUME, OTHER. Pick "OTHER" if none of the specific types clearly match. Also give a confidence between 0 and 1 for your classification.

Document text:
"""
${documentText.slice(0, 4000)}
"""`;
}

export interface DocumentClassificationOutcome {
  raw: string;
  success: boolean;
  data: DocumentClassification | null;
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

    return { raw, success: true, data: sanitizeInvoiceExtraction(result.data) };
  }

  async classifyDocument(
    documentText: string,
    model: string = env.OLLAMA_CHAT_MODEL
  ): Promise<DocumentClassificationOutcome> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");
    const prompt = buildClassificationPrompt(documentText);

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        format: DocumentClassificationJsonSchema,
        options: { temperature: 0.1 },
      },
      {
        // Same reasoning as extractInvoiceData's timeout, but this schema is tiny
        // (two fields) compared to the full invoice schema, so schema-constrained
        // decoding overhead is much smaller — 60s is ample.
        timeout: 60000,
      }
    );

    const raw = String(response.data?.message?.content ?? "");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { raw, success: false, data: null, error: "Model response was not valid JSON." };
    }

    const result = DocumentClassificationSchema.safeParse(parsedJson);
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
        // Measured directly against this CPU-only Ollama setup: a single real invoice
        // photo took qwen2.5vl:7b ~308s (5.1min) to transcribe — far past a fixed 180s
        // timeout, which silently failed every image-ingestion attempt (caught upstream
        // in DocumentIngestionService and logged as a warning, masquerading as a
        // "document quality too low" result instead of a timeout). All page images for
        // a document go into one /api/chat call, so the timeout scales with page count
        // rather than using a fixed ceiling that would only cover one page's worth of
        // measured time.
        timeout: images.length * VISION_TIMEOUT_PER_IMAGE_MS,
      }
    );

    return String(response.data?.message?.content ?? "").trim();
  }
}

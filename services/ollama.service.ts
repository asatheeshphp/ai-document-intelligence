import axios from "axios";
import { env } from "@/config/env";
import {
  InvoiceExtractionSchema,
  InvoiceExtractionJsonSchema,
  type InvoiceExtraction,
} from "@/schemas/invoice.schema";
import { DocumentClassificationSchema, type DocumentClassification } from "@/schemas/document-classification.schema";

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
// still get embedded and searched, and a bare, near-empty chunk like "CGST" with no
// rate or amount is exactly the kind of low-signal content that can surface above
// genuinely relevant results. Prompt wording alone didn't fully stop it (same lesson as
// sanitizeAddressRaw above), so drop any tax entry with no rate
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

// Schema-constrained JSON decoding (forcing the model straight into
// {documentType, confidence} with no room to reason first) was measured live to be
// nearly deterministically wrong on borderline content: a real recurring utility bill
// classified as OTHER on 10+ separate schema-constrained calls in a row, despite
// clearly being an invoice. Letting the model reason in free text first, then parse a
// final answer line, was the only approach observed to sometimes reach the correct
// answer (see classifyDocument's parseClassificationResponse) -- a small model appears
// to need that reasoning space to apply nuanced instructions at all, not just to
// explain itself after the fact.
function buildClassificationPrompt(documentText: string): string {
  return `Classify the document type of the text below into exactly one of: INVOICE, RECEIPT, PURCHASE_ORDER, CONTRACT, RESUME, OTHER. Pick "OTHER" if none of the specific types clearly match.

INVOICE includes ANY document billing a party for goods or services, one-time or
recurring -- this covers ordinary trade invoices as well as recurring subscription and
utility bills (internet, mobile/telecom, electricity, water, gas, cable/DTH, SaaS, and
similar recurring services). A document is still an INVOICE even if most of its content
is about the underlying service/plan/subscription details (e.g. package name, billing
period, account/customer ID, service address) rather than an itemized list of physical
goods -- what matters is that it is requesting payment for something provided, not
whether it looks like a traditional line-item trade invoice.

First, briefly explain your reasoning in 1-3 sentences. Then, on its own final line,
write exactly: ANSWER: <TYPE> <confidence>
where <TYPE> is one of INVOICE, RECEIPT, PURCHASE_ORDER, CONTRACT, RESUME, OTHER, and
<confidence> is a number between 0 and 1.

Document text:
"""
${documentText.slice(0, 4000)}
"""`;
}

// The confidence number is optional in the match -- observed live: the model
// sometimes writes "**ANSWER: INVOICE**" with no confidence at all, formatting
// requested but not always followed exactly. A correct type with no stated confidence
// shouldn't be thrown away as a parse failure; it falls back to a moderate default
// instead of the strongest (1) or weakest (0) value, since the model didn't actually
// state either extreme.
const CLASSIFICATION_ANSWER_PATTERN =
  /ANSWER:\s*(INVOICE|RECEIPT|PURCHASE_ORDER|CONTRACT|RESUME|OTHER)(?:\s+([0-9]*\.?[0-9]+))?/i;
const DEFAULT_CONFIDENCE_WHEN_UNSTATED = 0.75;

function parseClassificationResponse(raw: string): DocumentClassification | null {
  const match = raw.match(CLASSIFICATION_ANSWER_PATTERN);
  if (!match) return null;

  const documentType = match[1].toUpperCase() as DocumentClassification["documentType"];
  const confidence = match[2] != null ? Math.min(1, Math.max(0, parseFloat(match[2]))) : DEFAULT_CONFIDENCE_WHEN_UNSTATED;

  const result = DocumentClassificationSchema.safeParse({ documentType, confidence });
  return result.success ? result.data : null;
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
        options: { temperature: 0.1 },
      },
      {
        // No longer schema-constrained (see buildClassificationPrompt's comment) --
        // free-text reasoning plus a short answer line is still fast; 60s remains ample.
        timeout: 60000,
      }
    );

    const raw = String(response.data?.message?.content ?? "");

    const data = parseClassificationResponse(raw);
    if (!data) {
      return {
        raw,
        success: false,
        data: null,
        error: 'Model response did not contain a parseable "ANSWER: <TYPE> <confidence>" line.',
      };
    }

    return { raw, success: true, data };
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

  async translateToEnglish(text: string, model: string = env.OLLAMA_CHAT_MODEL): Promise<string> {
    const prompt = `Translate the following text to English. If it is already in English, output it unchanged. Output ONLY the translation — no explanation, no quotation marks, no commentary.

Text:
"""
${text}
"""`;

    return this.chatCompletion(prompt, model);
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

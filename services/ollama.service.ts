import axios from "axios";
import { env } from "@/config/env";
import {
  InvoiceExtractionSchema,
  InvoiceExtractionJsonSchema,
  type InvoiceExtraction,
} from "@/schemas/invoice.schema";
import { DocumentClassificationSchema, type DocumentClassification } from "@/schemas/document-classification.schema";
import { ChatIntentSchema, type ChatIntent } from "@/schemas/chat-intent.schema";

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

// Simplified from a 6-way classification (INVOICE/RECEIPT/PURCHASE_ORDER/CONTRACT/
// RESUME/OTHER) to a binary INVOICE/NOT_INVOICE decision, per explicit instruction --
// this app only ever acts on "is this an invoice or not" downstream, so the other 5
// categories only gave the model more ways to get confused without changing any
// behavior. Live-verified head to head: this binary prompt correctly and consistently
// classified two previously-misclassified real invoices (a furniture store invoice, a
// recurring ISP bill) as INVOICE across 5/5 runs each, and two genuine non-invoices
// (a resume, a service contract) as NOT_INVOICE across 3/3 runs each -- markedly more
// reliable than the earlier 6-way reasoning-then-parse prompt this replaces.
function buildClassificationPrompt(documentText: string): string {
  return `You are a document classifier for an invoice processing system.

Your only task is to determine whether the document is an INVOICE.

Return one of:
INVOICE
NOT_INVOICE

An INVOICE is a document that bills or requests payment from a customer for goods or services.

Invoice evidence may include:
- Invoice title or invoice number
- Bill To / Billed To / Customer
- Seller, supplier, or vendor
- Invoice date
- Due date
- Balance Due / Amount Due
- Subtotal, tax, discount, shipping, or total
- Line items with quantity, rate, price, or amount
- Payment terms
- Billing period
- Account or customer number
- Service address

Invoices may include:
- Product invoices
- Service invoices
- Utility bills
- Telecom/mobile/internet bills
- SaaS or subscription invoices
- Freight or logistics invoices
- Recurring bills

Important:
- The document does NOT need every invoice field.
- Missing fields do not mean it is NOT_INVOICE.
- An invoice can contain shipping information, order IDs, PO numbers, contract references, or service details.
- A PO number inside an invoice does NOT make it a purchase order.
- A paid invoice is still an invoice if its primary purpose and structure are an invoice.
- Use NOT_INVOICE only when the document is clearly not an invoice or there is insufficient evidence that it is an invoice.

Return ONLY one line in exactly this format:

ANSWER: <INVOICE|NOT_INVOICE> <confidence>

The confidence must be a number between 0 and 1.

Examples:
ANSWER: INVOICE 0.98
ANSWER: NOT_INVOICE 0.94

Document text:
"""
${documentText.slice(0, 4000)}
"""`;
}

// Both the "ANSWER:" prefix and the confidence number are optional in the match --
// observed live: the model sometimes writes "**ANSWER: INVOICE**" with no confidence,
// and separately sometimes drops the "ANSWER:" label entirely and just writes
// "NOT_INVOICE 0.98" on its own line, despite the prompt requesting the full format
// both times. A correct type shouldn't be thrown away as a parse failure just because
// the surrounding formatting wasn't followed exactly; missing confidence falls back to
// a moderate default rather than the strongest (1) or weakest (0) value, since the
// model didn't actually state either extreme.
const CLASSIFICATION_ANSWER_PATTERN = /(?:ANSWER:\s*)?(INVOICE|NOT_INVOICE)(?:\s+([0-9]*\.?[0-9]+))?/i;
const DEFAULT_CONFIDENCE_WHEN_UNSTATED = 0.75;

function parseClassificationResponse(raw: string): DocumentClassification | null {
  // Takes the LAST match, not the first -- the prompt asks for only the answer line
  // with no preamble, but a small model doesn't always follow that reliably. If it adds
  // reasoning anyway and happens to mention "invoice" before its actual conclusion, the
  // final occurrence is still the one that matters.
  const matches = [...raw.matchAll(new RegExp(CLASSIFICATION_ANSWER_PATTERN, "gi"))];
  const match = matches.at(-1);
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

// Distinguishes questions asking for a computed total ("how much have I paid X") from
// everything else (retrieval/summarization questions like "what did this invoice say").
// Follows the same reasoning-then-ANSWER-line pattern as buildClassificationPrompt --
// schema-constrained JSON decoding was measured unreliable on this model for the
// invoice classifier, and there is no reason to expect this smaller, similarly
// judgment-based decision to fare any better.
function buildChatIntentPrompt(question: string): string {
  return `You are deciding how to answer a question about a company's indexed invoices.

Decide which of four categories the question falls into:
- AGGREGATION: asking for a computed TOTAL/SUM of money spent with a specific VENDOR.
- LINE_ITEM_AGGREGATION: asking for a computed TOTAL/SUM of money spent on a PRODUCT,
  SERVICE, or CATEGORY (not a vendor name) -- e.g. "computer", "logistics services",
  "furniture".
- STATUS_FILTER: asking which invoices are paid, unpaid, or overdue -- a payment-status
  question, not a money-total question.
- RETRIEVAL: anything else -- finding, listing, or summarizing invoice content.

AGGREGATION examples (a VENDOR's total):
- "How much have I paid Readylink?"
- "What's my total spend with SuperStore this year?"
- "How much did I pay Express Cargo between January and March 2026?"

LINE_ITEM_AGGREGATION examples (a PRODUCT/CATEGORY's total, not a vendor):
- "Summarize the total computer-related amount."
- "How much did I spend on logistics services?"
- "What's the total for furniture line items?"

STATUS_FILTER examples:
- "Any unpaid invoices?"
- "Get unpaid invoices"
- "Which invoices are overdue?"
- "Show me the invoices I've already paid."
- "What is the payment status of invoice EXL-2026-2048?" (names ONE specific invoice)
- "Has invoice 27639 been paid?" (names ONE specific invoice)

RETRIEVAL examples:
- "What did the Readylink invoice say?"
- "Which invoices mention GST?"
- "Summarize the invoice from ABC Technologies."

If AGGREGATION, also extract the vendor name (as mentioned in the question, not
necessarily the full legal name) and, if a time period is mentioned, a from/to date
range in YYYY-MM-DD format. Do not invent a date range if none is mentioned.

Copy the vendor name EXACTLY as it appears in the question, character for character,
including every space between words -- do not join, split, or otherwise alter the
spelling. For example, "Express Cargo" must stay "Express Cargo", not "ExpressCargo".

If LINE_ITEM_AGGREGATION, extract the product/category keyword the same exact-copy way.

If STATUS_FILTER, also decide which status: UNPAID (not yet paid, including overdue),
OVERDUE (unpaid AND past its due date specifically), or PAID. If the question names ONE
specific invoice by number, also extract that invoice number EXACTLY as it appears
(same character-for-character rule as vendor names above) -- when a specific invoice is
named, the status you guess matters less than the invoice number itself, since the
question is really asking "what IS its status", not testing whether it matches a guess.

Return ONLY one line in exactly one of these formats:

ANSWER: AGGREGATION vendor="<vendor name>" from=<YYYY-MM-DD> to=<YYYY-MM-DD>
ANSWER: AGGREGATION vendor="<vendor name>"
ANSWER: LINE_ITEM_AGGREGATION keyword="<product or category>"
ANSWER: STATUS_FILTER status=<PAID|UNPAID|OVERDUE> invoiceNumber="<invoice number>"
ANSWER: STATUS_FILTER status=<PAID|UNPAID|OVERDUE>
ANSWER: RETRIEVAL

Examples:
ANSWER: AGGREGATION vendor="Readylink" from=2026-01-01 to=2026-12-31
ANSWER: AGGREGATION vendor="SuperStore"
ANSWER: LINE_ITEM_AGGREGATION keyword="computer"
ANSWER: STATUS_FILTER status=UNPAID
ANSWER: STATUS_FILTER status=UNPAID invoiceNumber="EXL-2026-2048"
ANSWER: RETRIEVAL

Question:
"""
${question}
"""`;
}

const CHAT_INTENT_PATTERN =
  /ANSWER:\s*(AGGREGATION|RETRIEVAL|STATUS_FILTER|LINE_ITEM_AGGREGATION)(?:\s+vendor="([^"]+)")?(?:\s+from=(\d{4}-\d{2}-\d{2}))?(?:\s+to=(\d{4}-\d{2}-\d{2}))?(?:\s+status=(PAID|UNPAID|OVERDUE))?(?:\s+keyword="([^"]+)")?(?:\s+invoiceNumber="([^"]+)")?/i;

function parseChatIntentResponse(raw: string): ChatIntent | null {
  // Same "take the last match" reasoning as parseClassificationResponse -- the model
  // isn't always reliable about outputting only the answer line with no preamble.
  const matches = [...raw.matchAll(new RegExp(CHAT_INTENT_PATTERN, "gi"))];
  const match = matches.at(-1);
  if (!match) return null;

  const type = match[1].toUpperCase() as ChatIntent["type"];
  const vendor = match[2] || undefined;
  const from = match[3] || undefined;
  const to = match[4] || undefined;
  const status = match[5]?.toUpperCase() as ChatIntent["status"] | undefined;
  const keyword = match[6] || undefined;
  const invoiceNumber = match[7] || undefined;

  const result = ChatIntentSchema.safeParse({ type, vendor, from, to, status, keyword, invoiceNumber });
  return result.success ? result.data : null;
}

export interface ChatIntentOutcome {
  raw: string;
  success: boolean;
  data: ChatIntent | null;
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

  async detectChatIntent(
    question: string,
    model: string = env.OLLAMA_CHAT_MODEL
  ): Promise<ChatIntentOutcome> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");
    const prompt = buildChatIntentPrompt(question);

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.1 },
      },
      {
        timeout: 60000,
      }
    );

    const raw = String(response.data?.message?.content ?? "");

    const data = parseChatIntentResponse(raw);
    if (!data) {
      return {
        raw,
        success: false,
        data: null,
        error:
          'Model response did not contain a parseable "ANSWER: AGGREGATION|RETRIEVAL|STATUS_FILTER|LINE_ITEM_AGGREGATION" line.',
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

import { SearchService } from "@/services/search.service";
import { OllamaService } from "@/services/ollama.service";
import { SpendQueryService, type VendorSpendSummary } from "@/services/spend-query.service";
import { ChatIntentService } from "@/services/chat-intent.service";
import { ProcessingRepository } from "@/repositories/processing.repository";
import type { SearchResultItem } from "@/services/search.service";
import type { ChatIntent } from "@/schemas/chat-intent.schema";

// NOTE: retrieval here goes through SearchService. Its previous top-1 English ranking
// limitation (see search.service.ts's LEXICAL_BOOST comment) is now addressed there via
// a lexical-overlap boost — no fix needed in this file, since it inherits SearchService's
// ranking as-is.
const RETRIEVAL_TOP_K = 8;
const NO_CONTEXT_ANSWER =
  "I couldn't find anything relevant in the indexed documents for that question. Try rephrasing it or ask about a topic covered by an ingested invoice.";

// Confirmed live: a question like "how much paid for logistics?" retrieved the correct
// invoice's header chunk (MAX_RESULTS_PER_INVOICE caps to 1 chunk per invoice, and the
// header happened to win the ranking here) but never its "payment" chunk (the one
// holding the actual Grand Total) -- so the model, lacking the real figure, borrowed a
// plausible-looking number from a completely different, unrelated invoice's chunk that
// was also in context. Ensuring each distinct invoice's payment chunk is available
// alongside whatever chunk search actually ranked highest gives the model a real chance
// at citing the right number, rather than needing the verification step below to catch
// it after the fact.
const UNGROUNDED_ANSWER_FALLBACK =
  "I found a related invoice, but couldn't confirm an exact figure from the retrieved content — the number I would have used didn't match that invoice's own data. Try asking about a specific invoice number for a more precise answer.";

// Skip line-item quantities, tax percentages, and other small incidental numbers --
// only figures this size or larger are meaningful enough to be worth verifying as a
// possible hallucinated/misattributed total.
const MIN_SIGNIFICANT_NUMBER = 10;

function extractSignificantNumbers(text: string): number[] {
  const matches = text.match(/\d[\d,]*\.?\d*/g) ?? [];
  return matches
    .map((match) => parseFloat(match.replace(/,/g, "")))
    .filter((value) => !Number.isNaN(value) && value >= MIN_SIGNIFICANT_NUMBER);
}

function getDistinctInvoices(results: SearchResultItem[]): SearchResultItem[] {
  const seen = new Map<string, SearchResultItem>();
  for (const result of results) {
    if (!seen.has(result.invoiceId)) seen.set(result.invoiceId, result);
  }
  return [...seen.values()];
}

function mentionsInvoice(answer: string, result: SearchResultItem): boolean {
  const lowerAnswer = answer.toLowerCase();
  const vendor = result.invoice?.vendorName?.toLowerCase();
  const invoiceNumber = result.invoice?.invoiceNumber?.toLowerCase();
  return Boolean((vendor && lowerAnswer.includes(vendor)) || (invoiceNumber && lowerAnswer.includes(invoiceNumber)));
}

export interface RagChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RagAnswerInput {
  question: string;
  history?: RagChatTurn[];
}

export interface RagAnswer {
  answer: string;
  sources: SearchResultItem[];
  // "computed" = a real database aggregation answered this (see SpendQueryService),
  // never approximated by the model. "retrieved" = today's existing retrieve-then-
  // summarize flow. Lets the UI show which kind of answer this actually is.
  mode: "computed" | "retrieved";
}

function formatSourceLabel(result: SearchResultItem, index: number): string {
  const parts = [
    result.invoice?.invoiceNumber ? `Invoice ${result.invoice.invoiceNumber}` : `Invoice ${index + 1}`,
    result.invoice?.vendorName,
    result.invoice?.invoiceDate ? new Date(result.invoice.invoiceDate).toISOString().slice(0, 10) : undefined,
  ].filter(Boolean);

  return parts.join(" — ");
}

function buildGroundedPrompt(question: string, history: RagChatTurn[], sources: SearchResultItem[]): string {
  const contextBlocks = sources
    .map((source, index) => `[${index + 1}] ${formatSourceLabel(source, index)}\n${source.chunkText}`)
    .join("\n\n");

  const historyBlock =
    history.length > 0
      ? `Prior conversation:\n${history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`).join("\n")}\n\n`
      : "";

  return `You are an AI assistant answering questions about a company's indexed invoices. Answer ONLY using the context below — never invent facts that aren't there.

Rules:
- If the context doesn't contain enough information to answer, say so plainly instead of guessing.
- When you use a fact from the context, mention which invoice it came from (e.g. "Invoice INV-1002").
- Be concise and factual. Do not repeat the raw context verbatim; synthesize an answer.

Context:
${contextBlocks}

${historyBlock}Question: ${question}`;
}

// Fixed string template, deliberately NOT an LLM call -- the number must always be
// exact, plain arithmetic already computed by SpendQueryService/MongoDB. The model's
// role stops at recognizing the question and extracting the vendor/date range; it never
// touches the total itself.
function formatSpendAnswer(summary: VendorSpendSummary, intent: ChatIntent): string {
  const vendorLabel = summary.vendorNames.join(" / ");
  const amountLabel =
    summary.currencies.length === 1
      ? `${summary.currencies[0]} ${summary.totalAmount.toFixed(2)}`
      : summary.totalAmount.toFixed(2);
  const invoiceWord = summary.invoiceCount === 1 ? "invoice" : "invoices";

  const rangeSuffix =
    intent.from && intent.to
      ? ` between ${intent.from} and ${intent.to}`
      : intent.from
        ? ` since ${intent.from}`
        : intent.to
          ? ` up to ${intent.to}`
          : "";

  const base = `You paid ${vendorLabel} ${amountLabel} across ${summary.invoiceCount} ${invoiceWord}${rangeSuffix}.`;

  // Summing across incompatible currencies would be a meaningless number -- flagged
  // rather than silently presented as if it were one real total (see design doc's
  // "Out of scope" note: actual currency conversion isn't attempted here).
  if (summary.currencies.length > 1) {
    return `${base} Note: these invoices use different currencies (${summary.currencies.join(", ")}), so this total mixes units and may not be a meaningful figure.`;
  }

  return base;
}

export class RagService {
  constructor(
    private readonly searchService: SearchService = new SearchService(),
    private readonly ollamaService: OllamaService = new OllamaService(),
    private readonly spendQueryService: SpendQueryService = new SpendQueryService(),
    private readonly chatIntentService: ChatIntentService = new ChatIntentService(),
    private readonly repository: ProcessingRepository = new ProcessingRepository()
  ) {}

  async answer(input: RagAnswerInput): Promise<RagAnswer> {
    const history = input.history ?? [];

    const intent = await this.chatIntentService.detectIntent(input.question).catch(() => null);

    if (intent?.type === "AGGREGATION" && intent.vendor) {
      const summary = await this.spendQueryService.getVendorSpendSummary({
        vendorNamePattern: intent.vendor,
        dateFrom: intent.from,
        dateTo: intent.to,
      });

      if (summary) {
        return { answer: formatSpendAnswer(summary, intent), sources: [], mode: "computed" };
      }
      // No invoices matched that vendor -- fall through to retrieval rather than
      // dead-ending, in case the extracted vendor name was wrong and retrieval can
      // still surface something useful.
    }

    const { results } = await this.searchService.search({
      query: input.question,
      topK: RETRIEVAL_TOP_K,
    });

    if (results.length === 0) {
      return { answer: NO_CONTEXT_ANSWER, sources: [], mode: "retrieved" };
    }

    const augmentedResults = await this.augmentWithPaymentChunks(results);

    const prompt = buildGroundedPrompt(input.question, history, augmentedResults);
    const answer = await this.ollamaService.chatCompletion(prompt);

    const grounded = await this.isAnswerGrounded(answer, augmentedResults);
    if (!grounded) {
      return { answer: UNGROUNDED_ANSWER_FALLBACK, sources: augmentedResults, mode: "retrieved" };
    }

    return { answer, sources: augmentedResults, mode: "retrieved" };
  }

  /**
   * Ensures each distinct invoice among the retrieved results also has its "payment"
   * chunk (the one holding the actual totals) available to the model, even if search's
   * per-invoice cap meant a different chunk (e.g. the header) won the ranking for that
   * invoice. Only adds a chunk that isn't already present -- never removes or reorders
   * what search actually ranked.
   */
  private async augmentWithPaymentChunks(results: SearchResultItem[]): Promise<SearchResultItem[]> {
    const augmented = [...results];
    const distinctInvoices = getDistinctInvoices(results);

    for (const invoiceResult of distinctInvoices) {
      const alreadyHasPaymentChunk = results.some(
        (result) => result.invoiceId === invoiceResult.invoiceId && result.chunkType === "payment"
      );
      if (alreadyHasPaymentChunk) continue;

      const chunks = await this.repository.findChunksByInvoiceId(invoiceResult.invoiceId);
      const paymentChunk = chunks.find((chunk) => chunk.chunkType === "payment");
      if (!paymentChunk) continue;

      augmented.push({
        ...invoiceResult,
        chunkId: paymentChunk._id.toString(),
        chunkType: "payment",
        chunkText: paymentChunk.text,
      });
    }

    return augmented;
  }

  /**
   * Verifies that any significant monetary figure the model stated actually appears in
   * the SPECIFIC invoice's own chunk text it's discussing -- not just somewhere among
   * all retrieved chunks, which could span several unrelated invoices. Confirmed live:
   * a naive "does this number appear anywhere in context" check would have passed a
   * hallucinated answer, since the borrowed number was real, just from a different
   * invoice. Only enforced when the answer clearly names exactly one invoice -- a
   * multi-invoice list-style answer (e.g. "3 invoices mention GST") is structurally
   * different and this single-invoice check doesn't cleanly apply to it.
   */
  private async isAnswerGrounded(answer: string, results: SearchResultItem[]): Promise<boolean> {
    const distinctInvoices = getDistinctInvoices(results);
    const namedInvoices = distinctInvoices.filter((result) => mentionsInvoice(answer, result));

    if (namedInvoices.length !== 1) return true;

    const answerNumbers = extractSignificantNumbers(answer);
    if (answerNumbers.length === 0) return true;

    const chunks = await this.repository.findChunksByInvoiceId(namedInvoices[0].invoiceId);
    const fullText = chunks.map((chunk) => chunk.text).join("\n");
    const contextNumbers = new Set(extractSignificantNumbers(fullText));

    return answerNumbers.every((number) => contextNumbers.has(number));
  }
}

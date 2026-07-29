import { SearchService } from "@/services/search.service";
import { OllamaService } from "@/services/ollama.service";
import { SpendQueryService, type VendorSpendSummary } from "@/services/spend-query.service";
import type { SearchResultItem } from "@/services/search.service";
import type { ChatIntent } from "@/schemas/chat-intent.schema";

// NOTE: retrieval here goes through SearchService. Its previous top-1 English ranking
// limitation (see search.service.ts's LEXICAL_BOOST comment) is now addressed there via
// a lexical-overlap boost — no fix needed in this file, since it inherits SearchService's
// ranking as-is.
const RETRIEVAL_TOP_K = 8;
const NO_CONTEXT_ANSWER =
  "I couldn't find anything relevant in the indexed documents for that question. Try rephrasing it or ask about a topic covered by an ingested invoice.";

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
    private readonly spendQueryService: SpendQueryService = new SpendQueryService()
  ) {}

  async answer(input: RagAnswerInput): Promise<RagAnswer> {
    const history = input.history ?? [];

    const intentOutcome = await this.ollamaService.detectChatIntent(input.question).catch(() => null);
    const intent = intentOutcome?.success ? intentOutcome.data : null;

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

    const prompt = buildGroundedPrompt(input.question, history, results);
    const answer = await this.ollamaService.chatCompletion(prompt);

    return { answer, sources: results, mode: "retrieved" };
  }
}

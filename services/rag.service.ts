import { SearchService } from "@/services/search.service";
import { OllamaService } from "@/services/ollama.service";
import { SpendQueryService, type VendorSpendSummary } from "@/services/spend-query.service";
import { InvoiceStatusQueryService, type InvoiceStatusSummaryItem } from "@/services/invoice-status-query.service";
import { ChatIntentService } from "@/services/chat-intent.service";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { hasMeaningfulTokens, extractMeaningfulTokens } from "@/utils/lexical-score";
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

// Confirmed live: asking "how much paid for internet 2026?" got a confident answer
// naming an unrelated logistics invoice as "the relevant invoice", with a dollar figure
// that genuinely was that invoice's own total -- so UNGROUNDED_ANSWER_FALLBACK's numeric
// check passed it. The real problem was the premise, not the number: "internet" never
// appears anywhere in that invoice's own text. This is a distinct failure mode (the
// model picking the closest-scoring but topically-unrelated retrieval result and
// asserting it's the answer) from a misattributed number, so it gets its own message.
const PREMISE_MISMATCH_FALLBACK =
  "I found an invoice that scored as a partial match, but its own content doesn't appear to mention what you asked about. Try rephrasing with an exact vendor name or invoice number.";

// Confirmed live: "The total logistics amount for Invoice INV-2026-2048 is 45,810
// rupees" spliced the letter-prefix of one real invoice ("INV-2026-001") onto the
// numeric suffix of a different real invoice ("EXL-2026-2048") -- a fabricated
// identifier that doesn't match anything on file, even though the dollar figure it
// carried genuinely was correct. Premise/numeric checks alone can't catch this: the
// number attributes cleanly to the right invoice, so both pass. This needs its own
// check specifically for invented identifiers.
const FABRICATED_IDENTIFIER_FALLBACK =
  "I mentioned an invoice identifier that doesn't match anything on file, so I can't confirm this answer. Try asking again, or reference a specific real invoice number.";

// Matches this corpus's real invoice-number shape (letters, a 2-4 digit segment, then
// another digit segment, dash-separated -- e.g. "EXL-2026-2048", "INV-2026-001").
// Deliberately narrow: broader alphanumeric-with-dashes patterns also cover PO numbers
// ("PO-45879") and multi-segment order IDs ("IN-2012-BF1121558-40955"), which are real,
// legitimate identifiers this check must not flag just for not being an invoice number.
const INVOICE_NUMBER_SHAPE_PATTERN = /\b[a-z]{2,6}-\d{2,4}-\d{1,6}\b/gi;

function extractInvoiceNumberShapedCandidates(text: string): string[] {
  return [...text.matchAll(INVOICE_NUMBER_SHAPE_PATTERN)].map((match) => match[0]);
}

// Skip line-item quantities, tax percentages, and other small incidental numbers --
// only figures this size or larger are meaningful enough to be worth verifying as a
// possible hallucinated/misattributed total.
const MIN_SIGNIFICANT_NUMBER = 10;

// Non-English questions are deliberately exempted from the premise check below: E5
// retrieval for a genuine non-English query with no literal anchor can correctly match
// an invoice with zero literal word overlap (see search.service.ts's own calibration
// note on why it retries via translation) -- rejecting on overlap here would throw away
// exactly the recall that fallback exists to protect.
const PLAIN_ASCII_PATTERN = /^[\x00-\x7F]*$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Confirmed live: reusing lexicalOverlapScore's raw-substring matching for this check
// let the filler word "all" (from "get all internet related invoices") count as a
// "match" purely because it's a substring of "allowance" in an unrelated line item --
// silently defeating the whole premise check even though "internet" itself, the
// question's actual subject, never appeared anywhere in the invoice. Word-boundary
// matching (\bword\b) closes that gap: substring matching stays fine for
// lexicalOverlapScore's ranking use case (e.g. "keyboards" matching "keyboard"), but a
// veto check needs to know a word actually occurs, not merely that its letters do.
function questionSharesVocabularyWith(question: string, invoiceText: string): boolean {
  const tokens = extractMeaningfulTokens(question);
  return tokens.some((token) => new RegExp(`\\b${escapeRegExp(token)}s?\\b`, "i").test(invoiceText));
}

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

// Returns which literal identifier string (if any) the answer used to reference this
// invoice, not just whether it matched -- confirmed live, this distinction matters:
// "The total for the SuperStore computer invoices is $1,330.29" matches BOTH of
// SuperStore's two real invoices (24938 and 27639) on the exact same vendor-name
// string, since they're the same vendor. Counting that as "2 invoices named" (the old
// boolean version did) wrongly triggered the multi-invoice skip meant for genuinely
// different invoices like "Vendor One and Vendor Two" -- silently disabling
// verification any time an answer names a vendor that owns more than one invoice.
// Invoice number is preferred over vendor name when both would match, since it's the
// unambiguous, never-shared identifier.
function matchedInvoiceIdentifier(answer: string, result: SearchResultItem): string | null {
  const lowerAnswer = answer.toLowerCase();
  const vendor = result.invoice?.vendorName?.toLowerCase();
  const invoiceNumber = result.invoice?.invoiceNumber?.toLowerCase();

  if (invoiceNumber && lowerAnswer.includes(invoiceNumber)) return `number:${invoiceNumber}`;
  if (vendor && lowerAnswer.includes(vendor)) return `vendor:${vendor}`;
  return null;
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

const STATUS_FILTER_LABELS: Record<"PAID" | "UNPAID" | "OVERDUE", string> = {
  PAID: "paid",
  UNPAID: "unpaid",
  OVERDUE: "overdue",
};

// Fixed string template, deliberately NOT an LLM call -- same reasoning as
// formatSpendAnswer: the list of invoices and their fields comes straight from
// InvoiceStatusQueryService/MongoDB, never touched by the model.
function formatStatusFilterAnswer(invoices: InvoiceStatusSummaryItem[], status: "PAID" | "UNPAID" | "OVERDUE"): string {
  const label = STATUS_FILTER_LABELS[status];

  if (invoices.length === 0) {
    return `I couldn't find any ${label} invoices.`;
  }

  const lines = invoices.map((invoice) => {
    const amountLabel =
      invoice.totalAmount !== undefined
        ? `${invoice.currency ? `${invoice.currency} ` : ""}${invoice.totalAmount.toFixed(2)}`
        : "amount unknown";
    const dueLabel = invoice.dueDate ? `, due ${invoice.dueDate.toISOString().slice(0, 10)}` : "";
    return `- Invoice ${invoice.invoiceNumber ?? "(unknown number)"} — ${invoice.vendorName ?? "(unknown vendor)"} — ${amountLabel}${dueLabel}`;
  });

  const invoiceWord = invoices.length === 1 ? "invoice" : "invoices";
  return `Found ${invoices.length} ${label} ${invoiceWord}:\n${lines.join("\n")}`;
}

export class RagService {
  constructor(
    private readonly searchService: SearchService = new SearchService(),
    private readonly ollamaService: OllamaService = new OllamaService(),
    private readonly spendQueryService: SpendQueryService = new SpendQueryService(),
    private readonly chatIntentService: ChatIntentService = new ChatIntentService(),
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly invoiceStatusQueryService: InvoiceStatusQueryService = new InvoiceStatusQueryService()
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

    if (intent?.type === "STATUS_FILTER" && intent.status) {
      // Unlike AGGREGATION's vendor match, a status value is a closed enum the model
      // either got right or (rarely) mis-set -- there's no "vendor name might be
      // slightly wrong" ambiguity to fall through on, so this always answers directly,
      // including the zero-results case ("I couldn't find any unpaid invoices" is
      // itself a real, useful answer, not a failure to dead-end from).
      const invoices = await this.invoiceStatusQueryService.listByStatus(intent.status);
      return { answer: formatStatusFilterAnswer(invoices, intent.status), sources: [], mode: "computed" };
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

    const groundingFailure = await this.checkAnswerGrounding(input.question, answer, augmentedResults);
    if (groundingFailure) {
      const fallback =
        groundingFailure === "premise"
          ? PREMISE_MISMATCH_FALLBACK
          : groundingFailure === "identifier"
            ? FABRICATED_IDENTIFIER_FALLBACK
            : UNGROUNDED_ANSWER_FALLBACK;
      return { answer: fallback, sources: augmentedResults, mode: "retrieved" };
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
   * Identifies which single invoice, among the distinct invoices in the retrieved
   * results, is a UNIQUE match for every significant number the answer stated.
   *
   * Confirmed live: "summarize the total computer invoice related amount" answered
   * "$4,069.53 + $78.66 = $4,148.20" without ever naming "SuperStore" or "27639" in the
   * text -- mentionsInvoice-based attribution alone found zero named invoices and
   * silently skipped verification entirely, even though the sources conclusively show
   * only invoice 27639 was actually used. This is the fallback for exactly that case:
   * when the answer doesn't literally cite an identifier, infer which invoice it's
   * really about from where its own stated numbers actually live. Only trusted when
   * the match is unique -- if the numbers coincidentally fit more than one invoice (or
   * fit none, e.g. a genuinely fabricated figure with no textual attribution to fall
   * back on either), there's nothing safe to narrow to, so it's left unattributed
   * rather than guessing.
   */
  private async attributeInvoiceByNumbers(
    answerNumbers: number[],
    distinctInvoices: SearchResultItem[]
  ): Promise<{ invoice: SearchResultItem; fullText: string } | null> {
    const matches: Array<{ invoice: SearchResultItem; fullText: string }> = [];

    for (const invoiceResult of distinctInvoices) {
      const chunks = await this.repository.findChunksByInvoiceId(invoiceResult.invoiceId);
      const fullText = chunks.map((chunk) => chunk.text).join("\n");
      const contextNumbers = new Set(extractSignificantNumbers(fullText));

      if (answerNumbers.every((number) => contextNumbers.has(number))) {
        matches.push({ invoice: invoiceResult, fullText });
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Verifies an answer that's attributable to exactly one invoice two ways -- a
   * multi-invoice list-style answer (e.g. "3 invoices mention GST") is structurally
   * different and neither check cleanly applies to it, so both are skipped whenever the
   * answer can't be narrowed to a single invoice.
   *
   * Attribution groups matches by which literal identifier STRING the answer used
   * (matchedInvoiceIdentifier), not by how many invoice records matched -- confirmed
   * live, these differ whenever a vendor owns more than one invoice: "the SuperStore
   * computer invoices" matches both of SuperStore's invoices on the same vendor-name
   * string, which isn't the same thing as an answer naming two genuinely different
   * invoices (e.g. "Vendor One and Vendor Two"). Three cases:
   * - Zero distinct identifiers named (the answer describes the invoice vaguely, e.g.
   *   "the computer invoices", never citing it): fall back to identifying it by which
   *   invoice's own text contains every significant number the answer states, among
   *   ALL retrieved invoices (see attributeInvoiceByNumbers).
   * - Exactly one distinct identifier named, matching exactly one invoice record: use
   *   it directly -- the common case.
   * - Exactly one distinct identifier named, matching MULTIPLE invoice records (a
   *   shared vendor): narrow to the specific one the same number-based way, but scoped
   *   to just that vendor's own invoices rather than the full retrieved set.
   * - Two or more distinct identifiers named: left unattributed either way -- a genuine
   *   multi-invoice answer, not something either check should second-guess.
   *
   * 1. Premise: does the attributed invoice's own text have anything to do with what
   *    was asked? Confirmed live: "how much paid for internet 2026?" got a confident
   *    answer naming an unrelated logistics invoice, stating that invoice's own real
   *    total -- the number check below would have passed it, since the number itself
   *    wasn't misattributed. "internet" simply never appears anywhere in that invoice's
   *    text. Skipped for non-English questions -- E5 retrieval can correctly match a
   *    genuine non-English query to an invoice with zero literal overlap (see
   *    search.service.ts's translation-fallback note), so rejecting on overlap here
   *    would throw away exactly the recall that exists to protect.
   * 2. Numeric: does any significant monetary figure the model stated actually appear in
   *    the SPECIFIC invoice's own chunk text -- not just somewhere among all retrieved
   *    chunks, which could span several unrelated invoices. Confirmed live: a naive
   *    "does this number appear anywhere in context" check would have passed a
   *    hallucinated answer, since the borrowed number was real, just from a different
   *    invoice.
   *
   * Runs one check first, unconditionally: does every invoice-number-SHAPED string in
   * the answer match a real invoice number among the retrieved results? Confirmed live:
   * "Invoice INV-2026-2048" spliced one real invoice's letter prefix onto a different
   * real invoice's numeric suffix -- a fabricated identifier, even though the dollar
   * figure attached to it was genuinely correct. This can't be caught by the
   * attribution-based checks below (the number attributes cleanly), so it runs
   * independently of whether the answer is otherwise single- or multi-invoice shaped.
   *
   * Returns which check failed (for fallback-message selection), or null if grounded.
   */
  private async checkAnswerGrounding(
    question: string,
    answer: string,
    results: SearchResultItem[]
  ): Promise<"premise" | "numeric" | "identifier" | null> {
    const distinctInvoices = getDistinctInvoices(results);

    const realInvoiceNumbers = new Set(
      distinctInvoices
        .map((invoice) => invoice.invoice?.invoiceNumber?.toLowerCase())
        .filter((invoiceNumber): invoiceNumber is string => Boolean(invoiceNumber))
    );
    const candidateIdentifiers = extractInvoiceNumberShapedCandidates(answer);
    const hasFabricatedIdentifier = candidateIdentifiers.some(
      (candidate) => !realInvoiceNumbers.has(candidate.toLowerCase())
    );
    if (hasFabricatedIdentifier) return "identifier";

    const answerNumbers = extractSignificantNumbers(answer);

    const matches = distinctInvoices
      .map((invoice) => ({ invoice, identifier: matchedInvoiceIdentifier(answer, invoice) }))
      .filter((match): match is { invoice: SearchResultItem; identifier: string } => match.identifier !== null);
    const distinctIdentifiers = new Set(matches.map((match) => match.identifier));

    let attributed: { invoice: SearchResultItem; fullText: string } | null = null;

    if (distinctIdentifiers.size === 0 && answerNumbers.length > 0) {
      attributed = await this.attributeInvoiceByNumbers(answerNumbers, distinctInvoices);
    } else if (distinctIdentifiers.size === 1) {
      const candidates = matches.map((match) => match.invoice);
      if (candidates.length === 1) {
        const chunks = await this.repository.findChunksByInvoiceId(candidates[0].invoiceId);
        attributed = { invoice: candidates[0], fullText: chunks.map((chunk) => chunk.text).join("\n") };
      } else if (answerNumbers.length > 0) {
        attributed = await this.attributeInvoiceByNumbers(answerNumbers, candidates);
      }
    }
    // distinctIdentifiers.size >= 2 leaves attributed = null -- genuine multi-invoice answer.

    if (!attributed) return null;

    const { fullText } = attributed;

    if (PLAIN_ASCII_PATTERN.test(question) && hasMeaningfulTokens(question)) {
      if (!questionSharesVocabularyWith(question, fullText)) return "premise";
    }

    if (answerNumbers.length === 0) return null;

    const contextNumbers = new Set(extractSignificantNumbers(fullText));
    if (!answerNumbers.every((number) => contextNumbers.has(number))) return "numeric";

    return null;
  }
}

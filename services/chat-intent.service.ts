import { OllamaService } from "@/services/ollama.service";
import type { ChatIntent } from "@/schemas/chat-intent.schema";

// Same failure mode as DocumentClassifierService, confirmed live: "How much have I
// paid Express Cargo?" was classified RETRIEVAL despite being phrased identically to
// "How much have I paid Readylink?" (correctly AGGREGATION) -- the model, not the
// regex/parser, made an inconsistent call. A single detectChatIntent call isn't
// reliable enough on its own; voting across a few independent attempts is, following
// the exact precedent that fixed the same problem for invoice classification.
const INTENT_VOTES = 3;

function majorityVote(votes: ChatIntent[]): ChatIntent {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote.type, (counts.get(vote.type) ?? 0) + 1);
  }

  // With 3 categories now (AGGREGATION/RETRIEVAL/STATUS_FILTER), a 3-vote split CAN be
  // a true tie (1-1-1), unlike the old 2-category version where 3 votes always had a
  // clear winner. Ties default to RETRIEVAL rather than an arbitrary first-occurrence
  // pick: both other categories present a computed number/list as fact, so an uncertain
  // vote should fall through to the safe retrieval path, not gamble on one of them.
  let winningType: ChatIntent["type"] | null = null;
  let winningCount = 0;
  let isTie = false;
  for (const [type, count] of counts) {
    if (count > winningCount) {
      winningCount = count;
      winningType = type as ChatIntent["type"];
      isTie = false;
    } else if (count === winningCount) {
      isTie = true;
    }
  }

  if (!winningType || isTie || winningType === "RETRIEVAL") {
    return { type: "RETRIEVAL" };
  }

  // Votes are agreeing on the *decision*, not necessarily on the extracted
  // vendor/date/status text verbatim -- using the first winning vote's extracted
  // fields rather than trying to merge/vote on them separately.
  return votes.find((vote) => vote.type === winningType)!;
}

// Confirmed live, deterministically (5/5 identical calls, not a random per-call
// disagreement voting could smooth over): the model reliably misreads "paid" (positive
// polarity, e.g. "get the paid invoices", "list paid invoices") as RETRIEVAL, while the
// identically-shaped "unpaid"/"overdue" questions classify correctly every time. Adding
// more few-shot examples to the prompt for this case was tried and measured to make it
// *worse* -- two previously-correct phrasings ("get all paid invoices", "which invoices
// have been paid?") flipped to wrong once more "paid" examples were added, showing this
// is a small-model capacity limit, not a prompt-wording gap. A deterministic keyword
// override is the reliable fix, same lesson as buildWhitespaceTolerantPattern earlier
// this session: a prompt fix alone isn't a guarantee.
//
// Scoped narrowly on purpose: only overrides when the LLM's own vote was RETRIEVAL (an
// already-STATUS_FILTER or AGGREGATION vote is left alone), and only matches "paid
// invoices" used as the direct object of a listing verb/question -- not any sentence
// that happens to mention both words, e.g. "Summarize the invoice from ABC that I
// already paid last month" doesn't match and correctly stays RETRIEVAL.
const PAID_STATUS_FILTER_PATTERNS = [
  /\b(get|list|show|find|display)\b(\s+(me|the|all|my))*\s+paid\s+invoices?\b/i,
  /\bwhich\s+invoices?\s+(have\s+been\s+|are\s+)?paid\b/i,
  /\bany\s+paid\s+invoices?\b/i,
];

function looksLikePaidStatusFilter(question: string): boolean {
  return PAID_STATUS_FILTER_PATTERNS.some((pattern) => pattern.test(question));
}

// Confirmed live, deterministically (3/3 identical calls): "What is the payment
// condition?" and "What are the payment conditions for Express Cargo?" both
// misclassified as STATUS_FILTER -- the model reads "condition(s)" as if it meant
// "status", when in ordinary invoice English "payment condition(s)" overwhelmingly
// means payment TERMS (e.g. "Net 14 Days", "due within 15 days"), a retrieval
// question. Confirmed the boundary is specifically this word: "payment terms?",
// "payment due date?", and "payment method?" all correctly stayed RETRIEVAL on the
// same live model. Scoped narrowly to the "payment condition(s)" phrase itself, not a
// broader "condition" ban, since that word has no other observed failure mode here.
const PAYMENT_CONDITION_MISCLASSIFICATION_PATTERN = /\bpayment\s+conditions?\b|\bconditions?\s+of\s+payment\b/i;

function looksLikePaymentTermsQuestion(question: string): boolean {
  return PAYMENT_CONDITION_MISCLASSIFICATION_PATTERN.test(question);
}

// UPCOMING is a brand-new status value the classifier prompt only just learned about
// (see ollama.service.ts) -- following the same "small model can't reliably do this on
// prompt wording alone" precedent as PAID_STATUS_FILTER_PATTERNS, this deterministic
// override guarantees "upcoming"/"due soon"/"due within N days" phrasing never silently
// falls through to RETRIEVAL, regardless of how the live model votes.
//
// Deliberately loose on the day-count phrasing (confirmed live: real questions used
// "next 10 days", "with in 10 days" (typo, two words), "within next 5 days", and "due in
// the next 5 days" -- four different word orders/spellings for the same idea) --
// extracting ANY "<N> day(s)" number from a question that's otherwise clearly about
// upcoming/due dates is far more reliable than trying to enumerate every phrasing
// combination. Requires either the word "upcoming"/"due soon", or the word "due" itself
// (as a standalone word, not "overdue") or "payment date", so it doesn't fire on
// unrelated "in the last N days" questions -- and explicitly excludes "overdue"/"past
// due" phrasing, which is a different, already-handled status.
const UPCOMING_WORD_PATTERN = /\b(upcoming|due\s+soon)\b/i;
const DUE_OR_PAYMENT_DATE_CONTEXT_PATTERN = /\bdue\b|\bpayment\s+date\b/i;
const ALREADY_OVERDUE_PATTERN = /\bover\s*due\b|\bpast\s+due\b/i;
const DAY_COUNT_PATTERN = /(\d+)\s*days?\b/i;

function matchUpcomingStatusFilter(question: string): number | null {
  const hasUpcomingWord = UPCOMING_WORD_PATTERN.test(question);

  if (!hasUpcomingWord) {
    if (ALREADY_OVERDUE_PATTERN.test(question)) return null;
    if (!DUE_OR_PAYMENT_DATE_CONTEXT_PATTERN.test(question)) return null;
  }

  const dayMatch = DAY_COUNT_PATTERN.exec(question);
  if (dayMatch) return Number(dayMatch[1]);
  return hasUpcomingWord ? 7 : null;
}

// Confirmed live: "get internet invoices" (lowercase) classified RETRIEVAL and failed
// ("there are no invoices specifically related to internet services..."), while the
// identically-meant "get Internet invoices" (capitalized) classified AGGREGATION
// vendor="Internet" and correctly resolved via a case-insensitive substring match
// against "Readylink Internet Services Limited". The model reads a capitalized word as
// a proper-noun vendor name but a lowercase one as an ordinary adjective, tipping the
// vote to RETRIEVAL -- same "small model capacity limit, not a prompt-wording gap"
// pattern as PAID_STATUS_FILTER_PATTERNS above, just triggered by casing instead of
// polarity.
//
// Rather than a vendor-specific pattern, this recognizes the general "get/list/show/find
// <category> invoices" shape and routes it to LINE_ITEM_AGGREGATION, reusing the
// existing handler's own vendor-match-then-line-item-total-then-retrieval fallthrough
// (rag.service.ts) -- so this override only needs to supply the extracted word
// correctly; it doesn't need to know whether that word turns out to be a real vendor, a
// real line-item keyword, or neither (in which case it safely falls through to
// retrieval exactly as before, unchanged from today's behavior).
//
// Filler-word denylist prevents "list all/my/the invoices" (no real category named) from
// being misread as a category query -- the regex's optional filler group can otherwise
// backtrack into capturing "all" itself as the "keyword".
const GENERIC_ITEM_INVOICE_PATTERN =
  /\b(?:get|list|show|find|display)\b(?:\s+(?:me|the|all|my))*\s+([a-z][a-z\s]{1,30}?)\s+invoices?\b/i;
const GENERIC_ITEM_FILLER_WORDS = new Set(["all", "the", "my", "me", "any", "every", "new", "recent", "latest"]);
// Payment-status words have their own dedicated STATUS_FILTER handling (either the
// model gets these right directly, or the PAID/UPCOMING overrides above already catch
// them) -- excluded here so a rare stray RETRIEVAL vote on one of these doesn't get
// captured as a nonsense LINE_ITEM_AGGREGATION keyword instead.
const GENERIC_ITEM_STATUS_WORDS = new Set(["paid", "unpaid", "overdue", "upcoming", "pending", "due"]);

function looksLikeGenericItemInvoiceQuery(question: string): string | null {
  const match = GENERIC_ITEM_INVOICE_PATTERN.exec(question);
  if (!match) return null;

  const word = match[1].trim();
  const normalized = word.toLowerCase();
  if (!word || GENERIC_ITEM_FILLER_WORDS.has(normalized) || GENERIC_ITEM_STATUS_WORDS.has(normalized)) return null;

  return word;
}

export class ChatIntentService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  /**
   * Detects chat intent by asking the model INTENT_VOTES times and taking a majority
   * vote, rather than trusting a single call -- see the constant's comment. A failed
   * individual attempt counts as a RETRIEVAL vote (the safe default: it just falls
   * through to the existing retrieval flow, never risks presenting a wrong computed
   * number).
   */
  async detectIntent(question: string): Promise<ChatIntent> {
    const votes: ChatIntent[] = [];

    for (let i = 0; i < INTENT_VOTES; i += 1) {
      const outcome = await this.ollamaService.detectChatIntent(question);
      if (!outcome.success || !outcome.data) {
        console.warn("Chat intent detection attempt failed, counting as RETRIEVAL:", outcome.error);
        votes.push({ type: "RETRIEVAL" });
      } else {
        votes.push(outcome.data);
      }
    }

    const result = majorityVote(votes);
    const upcomingDays = matchUpcomingStatusFilter(question);
    if (result.type === "RETRIEVAL" && upcomingDays !== null) {
      return { type: "STATUS_FILTER", status: "UPCOMING", dueWithinDays: upcomingDays };
    }
    if (result.type === "RETRIEVAL" && looksLikePaidStatusFilter(question)) {
      return { type: "STATUS_FILTER", status: "PAID" };
    }
    if (result.type === "STATUS_FILTER" && looksLikePaymentTermsQuestion(question)) {
      return { type: "RETRIEVAL" };
    }

    // Checked last, after the more specific paid/upcoming overrides above have already
    // had first refusal -- e.g. "list unpaid invoices" would otherwise get its "unpaid"
    // captured as a bogus LINE_ITEM_AGGREGATION keyword instead of staying/becoming the
    // correct STATUS_FILTER.
    if (result.type === "RETRIEVAL") {
      const genericKeyword = looksLikeGenericItemInvoiceQuery(question);
      if (genericKeyword) {
        return { type: "LINE_ITEM_AGGREGATION", keyword: genericKeyword };
      }
    }

    return result;
  }
}

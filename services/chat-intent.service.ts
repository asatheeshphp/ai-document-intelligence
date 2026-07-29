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
    if (result.type === "RETRIEVAL" && looksLikePaidStatusFilter(question)) {
      return { type: "STATUS_FILTER", status: "PAID" };
    }

    return result;
  }
}

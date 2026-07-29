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

    return majorityVote(votes);
  }
}

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
  const aggregationVotes = votes.filter((vote) => vote.type === "AGGREGATION");
  const retrievalCount = votes.length - aggregationVotes.length;

  // Only two categories exist, so a 3-vote split can never be a true tie (3-0 or 2-1
  // always has a clear winner) -- no tie-break needed, unlike DocumentClassifierService's
  // larger label set.
  if (aggregationVotes.length > retrievalCount) {
    // AGGREGATION votes are agreeing on the *decision*, not necessarily on the
    // extracted vendor/date text verbatim -- using the first AGGREGATION vote's
    // extracted fields rather than trying to merge/vote on them separately.
    return aggregationVotes[0];
  }

  return { type: "RETRIEVAL" };
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
